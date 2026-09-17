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

**Netcup VPS 500 G12** — 2 vCPU, 4 GB DDR5 ECC, 128 GB NVMe, Nuremberg or
Vienna. €5.91/mo incl. VAT, 12-month minimum term, no setup fee. Plus a domain
at $1–12/yr and Cloudflare at $0 (§4). Call it **$7/mo all-in**.

Hetzner was the obvious default and is now the wrong answer. It raised prices
twice in 2026 — a portfolio-wide +30–37% on 1 April, then an uneven adjustment
on 15 June that hit the RAM-heavy lines hardest: **CPX22 went €7.99 → €19.49/mo
ex-VAT, +144%**, which is 3.9× Netcup for the same 4 GB. The cheaper CX and CAX
lines would still be competitive at €5.49–5.99, but Hetzner has carried an open
"Limited availability of cloud instances" notice since 26 June and lists all
eight CX/CAX plans as unavailable in every EU location. Planning around a SKU
that cannot be ordered is planning on hope.

Two runners-up and why they lost, both for reasons specific to this codebase:

- **OVHcloud VPS-1, €3.81/mo** — cheapest verifiably orderable EU box, but its
  40 GB disk is exactly the floor with nothing spare. §8 notes that `candle` and
  `api_series.index_candle` grow without any retention or pruning; 128 GB
  removes a problem that 40 GB merely postpones, for €14/yr.
- **Contabo Cloud VPS 4, ~€4.62/mo for 8 GB** — rejected not for its documented
  I/O contention but because Contabo is reported to assign recycled,
  abuse-flagged IPs to some new accounts. The price publisher must hold four
  long-lived WSS sessions to Binance, Bybit, OKX and WhiteBIT, all of which
  filter on IP reputation. The failure mode is no price feed at all.

ECC is a genuine tiebreaker for a long-lived Postgres: the failure mode of a
silent bit-flip is corrupt data discovered a week later, not a crash.

Prices verified 2026-09-17. Hetzner's figures come from its published
price-adjustment changelog, since hetzner.com renders prices client-side; the
Netcup ex-VAT figure is computed from the VAT-inclusive price at 19%.

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

**Cloudflare Tunnel is the front door.** `cloudflared` runs on the VPS and dials
out to Cloudflare; no inbound port is opened, the firewall allows only SSH, and
the server's IP is never published. Cloudflare terminates TLS, absorbs DDoS and
serves cached static assets. This is free with no metered bandwidth — the
per-GB charge people associate with it belongs to Argo Smart Routing, a separate
opt-in product that stays off. WebSockets proxy fine on the free plan, subject
to the idle timeout handled in §6.

Caddy stays, bound to `127.0.0.1` only, doing path routing rather than TLS.
Keeping it means the whole topology is reproducible locally without Cloudflare
in the loop, and swapping the front door later touches one config file.

```
                    https://DOMAIN
          ┌──────────────────────────────┐
          │ Cloudflare — TLS, CDN, DDoS  │
          └──────────────┬───────────────┘
                         │ cloudflared tunnel (outbound only)
          ┌──────────────┴───────────────┐
          │ Caddy on 127.0.0.1 — routing │
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

Caddyfile — note it binds a plain local port, not a domain, because Cloudflare
already terminated TLS upstream:

```
:8080 {
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

**Why not a Cloudflare Worker.** Caching JSON-RPC at the edge is appealing and
was evaluated. The blocker is that the Workers Cache API accepts GET and HEAD
only — `cache.put()` throws on anything else — and the request body is never
part of the cache key. JSON-RPC is POST, so caching it means hashing the body
into a synthetic GET URL by hand, classifying methods and assigning TTLs: real
code to write and own, where eRPC is configuration. Cache Rules cannot help
either, since they are evaluated before the body is available. This stays
documented as a later optimisation for when edge locality actually matters,
not a launch dependency.

## 6. Code changes

Three one-line changes plus one small function. Everything else is new files
that sit outside the application.

1. **`apps/web/src/lib/wagmiConfig.ts`** — let the RPC URL be overridden:
   `http(process.env.NEXT_PUBLIC_RPC_URL ?? CHAIN_INFO.rpc)`. Absent the env var
   the behaviour is byte-for-byte what it is today, so local development is
   unaffected.
2. **`apps/web/.env.example`** — document `NEXT_PUBLIC_RPC_URL`.
3. **`services/indexer/.env.example`** — document `HEARTBEAT_START_BLOCK`. The
   variable is already read at `services/indexer/ponder.config.ts:41` and is
   load-bearing (§7), but is absent from the example file.
4. **`services/api/src/ws.ts`** — add a server-side ping every 30 s. This is the
   one behavioural change, and it exists only because of Cloudflare.

### Why the WebSocket needs a heartbeat

Cloudflare closes a proxied WebSocket when no data crosses it in either
direction for a period the docs decline to publish; the figure consistently
reported by users and Cloudflare staff is **100 seconds**. Cloudflare also warns
that network code releases restart servers and terminate connections outright.

The current server never sends unprompted traffic. `pollOnce()` deduplicates on
payload — `services/api/src/ws.ts:165` skips the send when the serialised
payload is unchanged — so a quiet channel emits nothing at all. A trader
subscribed to `positions:` or `orders:` with no activity receives literal
silence, and Cloudflare drops the socket at ~100 s.

This does not currently manifest, because local development has no proxy in the
path. It would appear only in production, as sockets that die roughly every two
minutes.

The client already handles the symptom: `apps/web/src/lib/ws.ts:71-76`
reconnects with exponential backoff capped at 30 s, resetting the counter on a
successful open (`:45`). So the visible failure is not a dead UI but a
connect-silence-drop-reconnect cycle, wasting connections and stalling updates
for up to a second each round.

Fix at the source: a 30-second `ws.ping()` interval per socket in `attach()`,
with the timer cleared on close. Roughly ten lines. Browser WebSocket clients
answer pings at the protocol level with no page-side code, so
`apps/web/src/lib/ws.ts` needs no change.

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

**Process supervision.** `cloudflared` runs as its own systemd unit, installed
from Cloudflare's repository and independent of the deploy script — it must
survive an application deploy untouched, since it is the only path in. Then one
unit per service, `Restart=always`,
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

The original plan was to rent an hourly Hetzner box, test, and discard it for
€0.01. Netcup's 12-month minimum term removes that escape hatch, so the
verification moves to the first hour of the real server's life:

1. Before anything else is installed, open all five outbound dependencies from
   the box — `wss://stream.binance.com:9443`, `wss://stream.bybit.com`,
   `wss://ws.okx.com:8443`, `wss://api.whitebit.com/ws`, and
   `https://rpc.testnet.whitechain.io`.
2. If a venue is blocked, decide whether to drop it from `PUBLISHER_VENUES` —
   note the k-of-N threshold of 3 governs *signers*, not venues, so the venue
   count is a separate, softer constraint — or to change provider.
3. Changing provider means invoking the 14-day withdrawal right that EU distance
   selling grants on a consumer contract. **Confirm before ordering** that
   Netcup's terms do not waive it on service commencement, which such terms
   commonly do.

The residual risk is low: exchange IP restrictions target US ranges, and German
data centres are not typically affected. But it is now a €71 bet rather than a
€0.01 one, so it gets checked first and deliberately.

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
| Disk fills from unbounded candles | Postgres stops accepting writes | 128 GB buys years; disk alert; retention is a separate future change |
| Cloudflare becomes a single point of failure | Site unreachable even though the VPS is healthy | Accepted for a testnet demo. Caddy already binds a plain port, so falling back to a direct A record plus Let's Encrypt is a config change, not a redesign |
| Cloudflare drops idle WebSockets | Reconnect churn, stalled updates | Server-side 30 s ping (§6) |
| Netcup 12-month minimum term | Cannot walk away mid-year | ~€71 total exposure; accepted |
| Key compromise on a public host | Testnet funds only; no mainnet exposure | Non-deploy keys never copied; 600/700 permissions |
| `NEXT_PUBLIC_API_BASE_URL=/api` is relative | Frontend cannot reach the API if the client does `new URL(base)` without a base argument | Verify the fetch helper in `apps/web/src/lib` accepts a relative base before building; if it does not, set the absolute `https://DOMAIN/api` instead — same-origin either way |

## 13. Success criteria

1. `https://DOMAIN` loads the trading terminal over valid TLS.
2. `https://DOMAIN/api/health` returns ok; `wss://DOMAIN/ws` accepts a
   subscription and pushes a price tick.
3. A `wss://DOMAIN/ws` subscription to a **deliberately quiet** channel survives
   **10 minutes** without a disconnect. This is the direct test of §6; a channel
   that happens to be busy proves nothing, because traffic masks the idle
   timeout.
4. The VPS has no inbound ports open to the internet — `nmap` from off-host
   shows nothing, and the site still works.
5. The browser's network panel shows chain calls going to `DOMAIN/rpc`, not to
   `rpc.testnet.whitechain.io`.
6. A wallet with WBT and claimed USDW opens and closes a BTC/USD position end to
   end, with the keeper fulfilling the price request.
7. `systemctl restart` of any single service is recovered automatically, and the
   full stack returns after `reboot`.
8. Indexer `/health` reports ok within 15 minutes of a cold start, not 6 hours.
9. A `pg_dump -n api_series` artifact exists and restores into a scratch
   database.
10. RSS of every unit is recorded after 24 h of uptime, replacing the estimates
    in §3 with a measured memory profile.
