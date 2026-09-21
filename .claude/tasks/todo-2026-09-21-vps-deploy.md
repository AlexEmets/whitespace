# Public testnet deploy to Hetzner CPX12 — 2026-09-21

Implements `docs/superpowers/specs/2026-09-17-public-testnet-hosting-design.md`
(status: approved, not implemented).

## Host reality vs. the design's assumptions

The design specced Netcup VPS 500 G12 (2 vCPU / 4 GB / 128 GB). The purchased
host is different, and three deltas change the plan:

| | Design | Actual (CPX12 #166802756) |
|---|---|---|
| vCPU | 2 | **1** |
| RAM | 4 GB | **2 GB** |
| Disk | 128 GB | **40 GB** |
| Swap | 2 GB, added | **none by default — must add** |
| Location | Nuremberg/Vienna | Helsinki |

Measured 2026-09-21 on the dev machine (PSS, not naive RSS):

| Component | Design estimate | Measured |
|---|---|---|
| Ponder indexer | 512 MB – 1 GB | **203 MB** (peak during backfill) |
| `next start` | 250 MB | **104 MB** |
| API (`tsx`) | 150 MB | **89 MB** |
| price-publisher | 100 MB | **41 MB** |
| `next build` | ~2 GB | **807 MB** (unchanged when pinned to 2 CPUs) |

Steady state lands at ~1.1–1.2 GB, leaving ~800 MB on a 2 GB box. `next build`
at 807 MB therefore does **not** fit alongside a running stack: the build must
stop `whitespace-web` and `whitespace-indexer` first, with 2 GB swap as the
backstop.

## Blocked on

- [ ] **SSH access.** `root@65.21.53.147` still answers
      `Permission denied (publickey,password)`; the host key is unchanged, so the
      server was never rebuilt. Needs `ssh-copy-id` from the user's machine.
- [ ] **Domain.** `NEXT_PUBLIC_WS_URL` / `NEXT_PUBLIC_RPC_URL` are baked at build
      time (design §6), so the final `next build` cannot run until DOMAIN exists.
      Everything up to the build can proceed without it.
- [x] **Decision 2026-09-21: the liquidator is omitted from this deploy.** It
      cannot liquidate on 1874 regardless, it has neither a `.env` nor a key
      locally, and skipping it removes the worst of the three memory leaks from
      a 2 GB box.

## Phase 1 — Repo changes (no server needed)

Design §6, four changes:

- [x] `apps/web/src/lib/config.ts` — new `RPC_URL` export, following the existing
      `process.env.NEXT_PUBLIC_* ?? default` idiom at `:25-26`.
      **Deviation from §6:** the design specified changing
      `http(CHAIN_INFO.rpc)` in wagmiConfig, but that file actually calls `http()`
      with no argument and derives the URL from the chain definition. Overriding
      at the transport (not in `rpcUrls`) keeps `wallet_addEthereumChain` handing
      visitors the canonical public endpoint instead of making their wallet
      depend on this deployment's domain.
- [x] `apps/web/src/lib/wagmiConfig.ts` — `http(RPC_URL)`
- [x] `apps/web/.env.example` — document `NEXT_PUBLIC_RPC_URL` (commented out;
      `readEnvFile` at `tools/stack/run.mjs:264` skips `#` lines, so this does
      not become a mandatory key for local dev)
- [x] `services/indexer/.env.example` — `HEARTBEAT_START_BLOCK=8400000` with the
      cold-start rationale; local `.env` pinned to the existing default 7373000
      so this machine's already-synced data is untouched
- [x] `services/api/src/ws.ts` — 30 s `ws.ping()` per socket via a new
      `pingIntervalMs` option, cleared on close
- [x] Verify: `services/api` 54/54 tests pass (incl. `test/ws.test.ts`);
      `tsc --noEmit` on apps/web clean

**Pre-existing, not mine:** `services/indexer/test/decode.test.ts` fails on a
fixture lookup. It imports only ABIs and static JSON fixtures — no env, no
config — so no edit above can reach it. Untouched per "flag, don't sweep".

## Phase 2 — Deploy artifacts (new files, no app behaviour change)

- [ ] `deploy/Caddyfile` — verbatim from design §4 (`handle_path /api/*` strips,
      `handle /ws` does not — both verified against the router and `ws.ts:188`)
- [ ] `deploy/systemd/whitespace-{publisher,keeper,indexer,api,web}.service`
      — `Restart=always`, `RestartSec=5`, explicit `Environment=HOME=/home/whitespace`,
      ordering publisher→keeper, postgres→indexer→api→web
- [ ] Add `MemoryMax=` per unit as the leak backstop (see §Known leaks)
- [ ] `deploy/deploy.sh` — must stop web+indexer before `next build`, not after
- [ ] `deploy/backup-api-series.sh` — nightly `pg_dump -n api_series`, 14-day retention
- [ ] `deploy/check-keeper-gas.sh` — 30-min balance check → Telegram
- [ ] `docs/runbooks/deploy-server.md`

## Phase 3 — Server bootstrap

- [ ] 2 GB swapfile (non-negotiable on this host — see the build math above)
- [ ] Unprivileged `whitespace` user; Node 22 via NodeSource; `corepack enable`
- [ ] Docker + compose (Postgres and eRPC only)
- [ ] `ufw`: 22 only. Cloudflare Tunnel is the front door, nothing else inbound
- [ ] `cloudflared` as its own systemd unit, installed from Cloudflare's repo so
      it survives app deploys
- [ ] journald `SystemMaxUse=500M` — the 40 GB disk is half the design's 128 GB
- [ ] **Pre-flight (design §10):** open all four exchange WSS endpoints plus the
      RPC from the box before trusting the price feed. Hetzner Helsinki is a
      data-centre range; Binance and OKX are the likely refusals.

## Phase 4 — Secrets and env

- [ ] `~/.whitespace-keys/` mode 700, files 600: `keeper.json` + `signer.json`
      .. `signer-5.json` (6 files). Verified 2026-09-21: all five signers exist
      and hold five **distinct** addresses, so k=3 is satisfiable.
- [ ] Deploy-time keys (`owner`, `gov`, `dev`, `manager`, `marketmaker`,
      `guardian`) are **not** copied — this deployment broadcasts nothing (§9)
- [ ] Per-service `.env` on the server, with `HEARTBEAT_START_BLOCK` set

## Phase 5 — Data plane

- [ ] `docker compose up -d postgres`; add eRPC on `127.0.0.1:4001`
- [ ] **`HEARTBEAT_START_BLOCK=8400000`.** Measured head 2026-09-21 is
      **8 406 360**; the design's 8 050 000 is already 356k blocks stale, which
      at `interval: 5` is ~71k `eth_getBlockByNumber` calls ≈ 3.3 h of pointless
      cold sync. Re-measure again immediately before first boot.
- [ ] Confirm eRPC behaves against 1874; fall back to the in-repo LRU proxy (§5)
      if it does not

## Phase 6 — Build, start, verify

- [ ] `apps/web/.env.local` with final DOMAIN values, then `next build`
- [ ] Enable and start all units; confirm recovery after `systemctl restart` and
      after `reboot`
- [ ] Walk design §13 criteria 1–9
- [ ] Criterion 10: record real RSS/PSS per unit after 24 h and replace the
      design's §3 estimates with measurements

## Known leaks — accepted, mitigated, not fixed here

Out of scope for the deploy (minimal diff), but they convert "fits in 2 GB" into
a countdown, so each gets a `MemoryMax=` backstop plus `Restart=always`:

- `services/liquidator/src/positionTable.mjs:52` — `remove()` is defined and
  exported at `:78` with **zero call sites**; every position opened stays in the
  sweep set forever. Independently verified.
- `services/keeper/src/deadLetter.mjs:17` and
  `services/liquidator/src/deadLetter.mjs:23` — unbounded arrays, no TTL; the
  liquidator's has no `remove()` at all and is memory-only by default.
- `services/api/src/ws.ts:49` — `SELECT * FROM position WHERE trader = $1` with
  no LIMIT, per subscribed wallet, every 2 s.

## Liquidator

`services/liquidator/.env` does not exist locally and there is no `liquidator`
key file. Per design §2 it cannot liquidate on 1874 at all
(`OstiumTradesUpKeep` undeployed, `executeAutomationOrder` is `onlyTradesUpKeep`),
so it would run purely as a monitor and metrics source. Decision needed: author
its config and run it, or omit it from this deploy.

## Review

_(changed / verified / left — filled in on completion)_
