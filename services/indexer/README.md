# @whitespace/indexer

Ponder 0.16 indexer for chain 1874. It turns contract logs into Postgres tables. Nothing is
served from this process: [`services/api`](../api) reads the tables for the terminal, and
the [automation bots](../liquidator) read their candidates (open positions, resting
LIMIT/STOP entries) from the same database.

```
chain 1874 ──eth_getLogs──► coalescing ─► rate limit (PONDER_MAX_RPS) ─► fallback(RPC urls)
                                │
              src/handlers/*.ts ▼  (Trading, TradingCallbacks, PriceUpKeep,
                                   PairsStorage, TradingStorage, Vault, ChainHeartbeat)
                         Postgres (DATABASE_SCHEMA) ──► services/api, automation bots
```

## What it indexes

The six contracts in `ponder.config.ts` all start at `CONTRACTS_START_BLOCK`. Their
addresses are compiled in from [`deployments/1874.json`](../../deployments/1874.json) and
cannot be set through env. `PriceUpKeep` also covers every address listed in
`contracts.previousPriceUpKeeps`, so a redeployed upkeep does not drop earlier requests,
reports and candles.

| Table | Written from |
|---|---|
| `market` | `PairAdded`, plus a one-time seed from `PairsStorage.pairs()` state (below); kept current by leverage/feed/OI-cap updates and OI deltas from opens and closes |
| `price_request`, `price_report` | `PriceRequestedV2`, `PriceReceived` |
| `order`, `order_event` | market/automation open and close initiations, executions, cancels and timeouts |
| `position`, `closed_position`, `partial_close`, `liquidation` | trade execution callbacks, TP/SL updates and margin edits |
| `limit_order` | `OpenLimitPlacedV2` / `OpenLimitUpdated` / `OpenLimitCanceled` / limit fills |
| `fee_charge` | the oracle, dev, vault-opening and liquidation fee events |
| `lp_activity`, `vault_settlement` | Vault deposit/withdraw requests, claims, cancels and settlements |
| `candle` | ticks from every `PriceReceived` (volume 0) and every executed trade (volume = collateral × leverage) |
| `points_event`, `wallet_points`, `points_daily`, `wallet_streak`, `wallet_lp` | season-one points (`src/lib/points.ts`, rules in `packages/shared/src/points.mjs`) |
| `sync_status` | the `ChainHeartbeat` block source |

All money and price columns are Ponder `bigint`, which Ponder stores as Postgres
`NUMERIC`. Scales are given at the top of `ponder.schema.ts`.

## How it works

- **Heartbeat.** `ChainHeartbeat` runs every 5 blocks from `HEARTBEAT_START_BLOCK` and
  overwrites the single `sync_status` row. The API's `/health` and the bots' indexer-lag
  check use this row, so lag is still measured when no contract events are arriving.
- **Market seed.** The node behind the public RPC has pruned its log index (no logs at or
  below about block 7,900,000), and `PairAdded` falls inside that range. So the first
  heartbeat after each boot rebuilds `market` from `PairsStorage` contract state
  (`src/lib/seedMarkets.ts`). These reads, and the reads in the `PairAdded` handler, use
  `latest`, because the node rejects `eth_call` against pruned historical state.
- **RPC budget.** The indexer, keeper and bots share a per-IP RPC limit. Three things keep
  the indexer within it:
  - `coalescingLogsTransport` serves Ponder's per-event `eth_getLogs` calls with one
    request per contract and range;
  - `rateLimitedTransport` limits outgoing requests to `PONDER_MAX_RPS`;
  - `ethGetLogsBlockRange` is fixed so that Ponder does not probe for the node's
    10,000-block limit.
- **Reorgs** are unwound by Ponder itself through its per-table `_reorg__*` shadow
  tables. The indexer has no reorg logic of its own.

## Configuration

Read by `ponder.config.ts` and `src/lib/*`:

| Variable | Default | |
|---|---|---|
| `PONDER_RPC_URLS_1874` | `https://rpc.testnet.whitechain.io` | Comma-separated, wrapped in viem `fallback()`. Do not use `rpc-testnet.whitechain.io` (hyphen), which is chain 2625 |
| `CONTRACTS_START_BLOCK` | `7284500` | Set it near the head: anything below about 8,300,000 indexes nothing on the public RPC |
| `HEARTBEAT_START_BLOCK` | `7373000` | Bump it to just below the head before a cold boot, or the backfill takes hours |
| `PONDER_POLLING_INTERVAL_MS` | `2000` | Integer ≥ 500 |
| `PONDER_MAX_RPS` | `5` | Integer 1..200 |
| `PONDER_GETLOGS_BLOCK_RANGE` | `9000` | Integer 1..10000 |
| `PONDER_DB_POOL_MAX` | `12` | Integer ≥ 5 (Ponder splits it across its pools) |

Read by Ponder itself:

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | unset → embedded PGlite | Set it for any real run; it must be the database the API and bots read |
| `DATABASE_SCHEMA` | – | Schema the tables are created in. `ponder start` refuses to run without one |
| `PORT` | `42069` | Ponder's own HTTP server |
| `PONDER_LOG_LEVEL` | `info` | |
| `PONDER_TELEMETRY_DISABLED` | unset | Any truthy value disables telemetry |

[`.env.example`](.env.example) explains each one, including the measurements behind the
start-block advice.

## Running locally

```bash
docker compose up -d postgres            # 127.0.0.1:5433, user/db whitespace
cp services/indexer/.env.example services/indexer/.env   # set both start blocks near the head
cd services/indexer
set -a && . ./.env && set +a             # export the env explicitly (see below)
pnpm dev                                 # ponder dev; `pnpm start` for ponder start
```

The unit file records that `ponder start` does not read `.env` from this directory (it reads
`.env.local`), which contradicts `.env.example`. Exporting the variables yourself works
either way. Ponder serves its built-in `/health`, `/ready` and `/status` on `PORT`.
`src/api/index.ts` is an empty Hono app that exists only because Ponder requires one.

## Tests

```bash
pnpm --filter @whitespace/indexer test     # vitest run; no RPC, no Postgres, no Ponder runtime
```

The tests cover handler libraries, the transports and the config parsers. Event decoding is
checked against real receipts recorded in [`fixtures/`](fixtures/README.md).

## Operations

- **Schema per build.** Ponder refuses to reuse a schema that a different build created.
  `deploy/deploy.sh` writes `DATABASE_SCHEMA=ws1874_<sha>` (from `deploy/indexer-schema.sh`)
  into `.env.build`. The unit then runs `ponder start --schema ${DATABASE_SCHEMA}
  --views-schema ws1874`. Once a new build has synced, Ponder repoints the stable views in
  `ws1874`. The API (`INDEXER_SCHEMA`) and the bots (`DATABASE_SCHEMA`) read only those
  views, so an indexer deploy does not break them, and the old build keeps serving until
  the new one is ready.
- **Rebuildable.** Everything the indexer owns can be rebuilt from chain. The Postgres
  volume is a cache.
- **Lag** shows on the API's `GET /health` (`degraded` above 30 s, `down` above 5 min) and
  on the bots' `liquidator_indexer_lag_*` metrics.
- **Logs.** The unit runs at `--log-level warn`, because RPC retries logged at `info`
  previously filled the disk.
- **systemd:** `deploy/systemd/whitespace-indexer.service`, see
  [`docs/runbooks/deploy-server.md`](../../docs/runbooks/deploy-server.md).

Design notes, decoding checks and reorg handling:
[`docs/decisions/phase-4-indexer-api.md`](../../docs/decisions/phase-4-indexer-api.md).
