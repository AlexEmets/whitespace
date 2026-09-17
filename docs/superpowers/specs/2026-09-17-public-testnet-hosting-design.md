# Public testnet hosting — design

Date: 2026-09-17
Status: approved, not implemented
Supersedes the "Public hosting is out of scope" line in
`docs/superpowers/specs/2026-09-09-live-trading-launch-design.md:58`.

## 1. Goal

Put the existing chain-1874 deployment behind a public HTTPS URL that anyone can
open, connect an injected wallet to, and trade on, running 24/7 on one cheap VPS.

### Non-goals

Nothing in this design broadcasts an on-chain transaction. Specifically out of
scope, and each stays broken exactly as it is today:

- **Liquidations.** `OstiumTradesUpKeep` is still undeployed and
  `executeAutomationOrder` is `onlyTradesUpKeep`, so no address can liquidate on
  1874 (`services/liquidator/src/config.mjs` header). The liquidator runs as a
  monitor and metrics source only.
- **ETH/USD and SOL/USD listings.** Only `pairIndex 0 = BTC/USD` exists on
  chain; `contracts/broadcast/Operate.s.sol/dry-run/runAddMarkets-latest.json`
  was never broadcast.
- **Gas onboarding.** `faucet.testnet.whitechain.io` is gated by Cloudflare
  Turnstile plus GitHub OAuth, and `anvil_setBalance` / `hardhat_setBalance` /
  `eth_requestFunds` all return `rpc method is not whitelisted`
  (`docs/runbooks/deploy-testnet.md`). Visitors fetch their own WBT by hand.
- Mainnet 1875, chain 2625, contract redeployment, CI/CD pipelines.

## 2. What already exists

Six long-running processes plus Postgres, all currently started by
`tools/stack/run.mjs`:

| Service | Entrypoint | Listens | State |
|---|---|---|---|
| `services/price-publisher` | `src/main.mjs` | `:8787` | none on disk; 4 outbound WSS |
| `services/keeper` | `src/main.mjs` | none | optional dead-letter JSONL |
| `services/liquidator` | `src/main.mjs` | `:9464` | optional dead-letter JSONL |
| `services/indexer` | `ponder start` | `:42069` | Postgres |
| `services/api` | `tsx src/server.ts` | `:4000` | Postgres (`api_series`) |
| `apps/web` | `next start` | `:3000` | none |

`tools/stack/run.mjs` stays a development tool. It launches `next dev` and has
no restart-on-crash, so production uses systemd instead. Its `.env`-versus-
`.env.example` coverage pre-flight is genuinely useful and is retained for local
work — see §6 for the one consequence that has on this change.

## 3. Host

**Hetzner CX22** — 2 vCPU x86, 4 GB RAM, 40 GB NVMe, Nuremberg. About €3.79/mo
plus €0.50/mo for the IPv4 address, so roughly **$4.60/mo**. A domain adds
$1–12/yr.

x86 rather than the similarly priced CAX11 (ARM): the price difference is
negligible and ARM introduces avoidable risk around native binaries in the
dependency tree (SWC, Postgres client bindings, anything Ponder pulls in).

Add **2 GB of swap**. Steady-state usage is roughly 2 GB (Postgres ~256 MB,
Ponder 512 MB–1 GB, `next start` ~250 MB, `tsx`-hosted API ~150 MB, three small
Node services ~100 MB each, Caddy ~30 MB, eRPC ~150 MB), but `next build` peaks
near 2 GB on its own. Swap prevents the build from OOM-killing running services.

Run everything as an unprivileged `whitespace` user. Node 22 from NodeSource so
systemd has an absolute `/usr/bin/node`; pnpm via `corepack enable`. Firewall
(`ufw`) allows 22, 80, 443 and nothing else.

## 4. Topology

One origin. A single domain, supplied as the deployment parameter `DOMAIN`,
serves the frontend, the API, the WebSocket and the RPC proxy. Because the
browser then talks to one origin only, CORS never engages and
`CORS_ALLOWED_ORIGINS` stops mattering.

```
                    https://DOMAIN
          ┌──────────────────────────────┐
          │ Caddy — automatic TLS        │
          └──────────────┬───────────────┘
                         │
  /            ────────► 127.0.0.1:3000   apps/web (next start)
  /api/*       ────────► 127.0.0.1:4000   services/api  (prefix stripped)
  /ws          ────────► 127.0.0.1:4000   services/api  (prefix preserved)
  /rpc         ────────► 127.0.0.1:4001   eRPC → rpc.testnet.whitechain.io

  bound to 127.0.0.1, never exposed:
    :8787   price-publisher   (keeper and liquidator are local clients)
    :9464   liquidator /metrics
    :42069  indexer
    :5433   postgres
```

Two routing details are load-bearing and were verified against the source:

- The API router registers bare paths — `router.get('/health')`,
  `/markets`, `/markets/:pairIndex/candles`, `/positions/:address`
  (`services/api/src/server.ts:13-20`). There is no `/api` prefix in the
  service, so Caddy must **strip** it: `handle_path /api/*`.
- The WebSocket server is constructed as
  `new WebSocketServer({ server, path: '/ws' })` (`services/api/src/ws.ts:188`),
  which matches the literal path. So `/ws` is proxied **without** stripping.

Caddyfile:

```
DOMAIN {
	encode gzip zstd

	handle /ws {
		reverse_proxy 127.0.0.1:4000
	}

	handle_path /api/* {
		reverse_proxy 127.0.0.1:4000
	}

	handle /rpc {
		rewrite * /main/evm/1874
		reverse_proxy 127.0.0.1:4001
	}

	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
```

The publisher is deliberately not exposed. `GET /v2/report` returns k-of-N
signed price reports; the only consumer is the keeper on the same host.

## 5. RPC proxy

Today every visitor's browser calls `rpc.testnet.whitechain.io` directly —
`apps/web/src/lib/wagmiConfig.ts` builds its transport from `CHAIN_INFO.rpc`,
hardcoded at `packages/shared/src/chains.mjs:5`. Under a public launch, N
visitors become N independent sources of rate-limit pressure, queued against the
indexer, keeper and liquidator on the one endpoint that
`services/indexer/ponder.config.ts:22-27` documents as the only known one.

Routing the frontend through `https://DOMAIN/rpc` collapses that to a single
outbound client with a cache in front of it.

**Use eRPC** (`ghcr.io/erpc/erpc`), added as a second service to the existing
`docker-compose.yml` alongside Postgres. It is purpose-built for this: JSON-RPC
response caching keyed on method and params, per-method TTLs, rate limiting,
Prometheus metrics, and a multi-upstream slot ready for the day a second
Whitechain endpoint is confirmed to exist. It requires no new code in this repo.
Bind it to `127.0.0.1:4001`, not its default 4000, which would collide with
`services/api`.

**Risk and fallback.** eRPC has not been exercised against Whitechain 1874 in
this project. If its cache keying or upstream handling misbehaves against this
chain, replace it with a purpose-written Node proxy — roughly 120 lines, an LRU
keyed on `(method, params)` with per-method TTLs (`eth_chainId` forever,
`eth_blockNumber` ~1 s, `eth_call` ~2 s, `eth_getLogs` by block range) — run as a
seventh systemd unit. The Caddy route and the frontend change are identical
either way, so this swap costs nothing downstream.

## 6. Code changes

Three lines of product code. Everything else is new files that sit outside the
application.

1. **`apps/web/src/lib/wagmiConfig.ts`** — let the RPC URL be overridden:
   `http(process.env.NEXT_PUBLIC_RPC_URL ?? CHAIN_INFO.rpc)`. Absent the env var
   the behaviour is byte-for-byte what it is today, so local development is
   unaffected.
2. **`apps/web/.env.example`** — document `NEXT_PUBLIC_RPC_URL`.
3. **`services/indexer/.env.example`** — document `HEARTBEAT_START_BLOCK`. The
   variable is already read at `services/indexer/ponder.config.ts:41` and is
   load-bearing (§7), but is absent from the example file.

**Consequence of change 3.** `tools/stack/run.mjs` refuses to boot when a
service's `.env` does not cover every key in its `.env.example`. Adding
`HEARTBEAT_START_BLOCK` to the example therefore makes it mandatory for the
local stack too. The local `services/indexer/.env` must gain the key in the same
commit or local development breaks. This is the intended outcome — the variable
should never have been implicit — but it must not be discovered at runtime.

New files, none of which alter application behaviour:

```
deploy/Caddyfile
deploy/systemd/whitespace-{publisher,keeper,liquidator,indexer,api,web}.service
deploy/deploy.sh
deploy/backup-api-series.sh
deploy/check-keeper-gas.sh
docs/runbooks/deploy-server.md
```

`NEXT_PUBLIC_*` values are baked in at build time, so `apps/web/.env.local` on
the server must carry the final public values before `next build` runs:
`NEXT_PUBLIC_API_BASE_URL=/api`, `NEXT_PUBLIC_WS_URL=wss://DOMAIN/ws`,
`NEXT_PUBLIC_RPC_URL=https://DOMAIN/rpc`, `NEXT_PUBLIC_CHAIN_ID=1874`.

## 7. Cold start — the heartbeat gap

This is the single largest operational hazard and it is fully deterministic.

Measured 2026-09-17: head of chain 1874 is **8 055 869** (`eth_blockNumber` →
`0x7aea3d`). The default `HEARTBEAT_START_BLOCK` is **7 373 000**, chosen on
2026-09-09. The gap is **682 869 blocks**, and the heartbeat block source runs at
`interval: 5`, so a cold sync issues **≈136 574 `eth_getBlockByNumber` calls**.
At the ~6 blocks/s the authors measured against this RPC
(`services/indexer/ponder.config.ts:60-79`) that is **≈6.3 hours** before
`/health` reports ok.

Contract indexing is not the problem: from `startBlock = 7 284 500` to head is
771 369 blocks, and chunked `eth_getLogs` at 9 000 blocks per request means ~86
requests per contract — minutes, not hours.

**Therefore:** set `HEARTBEAT_START_BLOCK=8050000` in the server's
`services/indexer/.env` before the first boot, and re-check it before any future
rebuild from an empty database. A stale value does not degrade gracefully — it
looks like a hung deploy.

## 8. Persistence and backup

Postgres 16 stays in the existing `docker-compose.yml`, unchanged, on
`127.0.0.1:5433`.

The compose header's claim that the volume is a cache rather than a system of
record is true for everything Ponder owns, and false for one schema.
`services/api/src/indexSeries.ts` creates and fills `api_series.index_candle`
from a background timer sampling the publisher. Ponder neither owns nor
reconstructs it; if the volume is lost, that history is gone permanently.

**Backup is therefore exactly one schema:** a nightly
`pg_dump -n api_series` to `/var/backups/whitespace/`, retaining 14 days. Small,
and it is the only irreplaceable state on the box.

Note that `candle` and `api_series.index_candle` grow forever — one row per
interval per bucket, with no retention or pruning anywhere in the codebase. At
one market this is immaterial for months, but it is unbounded and worth a disk
alert rather than a surprise.

## 9. Operations

**Process supervision.** One systemd unit per service, `Restart=always`,
`RestartSec=5`, `WantedBy=multi-user.target` for start-on-boot. Ordering via
`After=`/`Requires=`: Postgres before indexer, indexer before api, api before
web; publisher before keeper and liquidator. Each unit sets
`Environment=HOME=/home/whitespace` explicitly — the `.env.example` files warn
repeatedly that an unset `HOME` resolves key paths to a literal
`undefined/...` and fails with ENOENT.

**Secrets.** Seven key files reach the server, in `~/.whitespace-keys/`, mode
600 inside a 700 directory, in the format `packages/shared/src/keys.mjs` expects
(a one-element array with `address` and `private_key`): `keeper`, `liquidator`,
and `signer` through `signer-5`. The deploy-time keys — `owner`, `gov`, `dev`,
`manager`, `marketmaker` — must **not** be copied, since this design broadcasts
nothing. All five signers on one host proves the threshold mechanism and
provides no distributed custody; that is unchanged from the launch design and
acceptable for testnet.

**Gas alerting.** The keeper and liquidator EOAs pay gas and can only be refilled
by a human passing a CAPTCHA. A cron job reads both balances every 30 minutes
and sends a Telegram message below a threshold. Set that threshold at
implementation time to ten days of the burn rate observed over the first 24
hours of live operation — guessing it up front would either cry wolf or fire too
late. Without the alert the failure mode is silent: orders simply stop being
fulfilled.

**Deploy.** `deploy/deploy.sh`, run as `whitespace`:

```sh
set -euo pipefail
cd /home/whitespace/whitespace
git pull --ff-only
pnpm install --frozen-lockfile
pnpm --filter @whitespace/web build
sudo systemctl restart whitespace-publisher whitespace-keeper \
  whitespace-liquidator whitespace-indexer whitespace-api whitespace-web
```

Contracts are never built on the server. `foundry.toml` sets `via_ir = true`,
which is CPU- and RAM-hungry, and nothing here needs `forge`. The git submodules
(`forge-std`, both OpenZeppelin trees) can be left uninitialised on the server.

**Logs.** journald per unit, with `SystemMaxUse=500M` so a chatty service cannot
fill a 40 GB disk.

## 10. Pre-flight verification, before committing to the host

The publisher opens outbound WebSockets to Binance, Bybit, OKX and WhiteBIT
(`services/price-publisher/src/venues/*.mjs`), and some exchanges refuse
connections from data-centre IP ranges. If any venue is blocked, the weighted
median degrades or the publisher fails outright.

Hetzner bills by the hour, so the first implementation step is: create the CX22,
and from it verify all five outbound dependencies — `wss://stream.binance.com:9443`,
`wss://stream.bybit.com`, `wss://ws.okx.com:8443`, `wss://api.whitebit.com/ws`,
and `https://rpc.testnet.whitechain.io`. Only then buy the domain and proceed.
If a venue is blocked, the decision is whether to drop it from
`PUBLISHER_VENUES` (the k-of-N threshold is 3 of 5 signers, but venue count is
separate) or choose a different provider. Aborting at this point costs about
€0.01.

## 11. Accepted limitations, to be stated in the UI

A public URL implies a promise. These must be visible to visitors rather than
discovered:

- Positions are never liquidated on this deployment.
- Only BTC/USD trades; ETH/USD and SOL/USD appear in the market list because
  `packages/shared/src/markets.mjs` lists them, but have no on-chain pair.
- Trading requires WBT for gas, obtainable only from the official faucet, which
  requires a GitHub account and a CAPTCHA. USDW collateral, by contrast, is
  self-serve: `USDW.claim()` mints 1 000 USDW per address per 24 h.

## 12. Residual risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Single RPC endpoint | Total blindness if it goes down | eRPC caching absorbs load; a second upstream can be added without code changes. No mitigation exists for a full outage. |
| Keeper runs out of gas | Orders silently stop filling | Balance alert (§9); manual refill |
| eRPC misbehaves on 1874 | RPC proxy unusable | Documented fallback to an in-repo LRU proxy (§5) |
| Exchange blocks Hetzner IPs | Degraded or dead price feed | Verified before purchase (§10) |
| Disk fills from unbounded candles | Postgres stops accepting writes | Disk alert; retention is a separate future change |
| Key compromise on a public host | Testnet funds only; no mainnet exposure | Non-deploy keys never copied; 600/700 permissions |
| `NEXT_PUBLIC_API_BASE_URL=/api` is relative | Frontend cannot reach the API if the client does `new URL(base)` without a base argument | Verify the fetch helper in `apps/web/src/lib` accepts a relative base before building; if it does not, set the absolute `https://DOMAIN/api` instead — same-origin either way |

## 13. Success criteria

1. `https://DOMAIN` loads the trading terminal over valid TLS.
2. `https://DOMAIN/api/health` returns ok; `wss://DOMAIN/ws` accepts a
   subscription and pushes a price tick.
3. The browser's network panel shows chain calls going to `DOMAIN/rpc`, not to
   `rpc.testnet.whitechain.io`.
4. A wallet with WBT and claimed USDW opens and closes a BTC/USD position end to
   end, with the keeper fulfilling the price request.
5. `systemctl restart` of any single service is recovered automatically, and the
   full stack returns after `reboot`.
6. Indexer `/health` reports ok within 15 minutes of a cold start, not 6 hours.
7. A `pg_dump -n api_series` artifact exists and restores into a scratch
   database.
