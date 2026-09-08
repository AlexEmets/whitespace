# Phase 4 — Indexer and Read API

**Date:** 2026-09-08
**Scope:** `services/indexer/` (Ponder → Postgres) and `services/api/` (REST + WebSocket)
**Status:** Implemented and tested; live-verified against real chain data on Whitechain testnet 1874

---

## 1. What was built

### 1.1 `services/indexer/` — Ponder → Postgres

A Ponder project (TypeScript) that indexes six contracts on chain 1874 (addresses from
`deployments/1874.json`): `Trading`, `TradingCallbacks`, `PriceUpKeep`, `PairsStorage`,
`TradingStorage`, `Vault`. Event ABIs were transcribed by hand from the vendored interface
files (`contracts/src/vendor/ostium/interfaces/*.sol`) into `abis/*.ts` — **never guessed**;
every signature used for the critical open/close/price path was cross-checked against a real
decoded log from testnet 1874 (§3).

Events indexed, mapped to the task's "at minimum" list:

| Requirement | Events | Table(s) |
|---|---|---|
| Orders requested | `MarketOpenOrderInitiated`, `MarketCloseOrderInitiatedV2`, `AutomationOpenOrderInitiated`, `AutomationCloseOrderInitiated`, `RemoveCollateralInitiated` | `order` |
| Price requests | `PriceRequestedV2` | `price_request` |
| Price reports delivered | `PriceReceived` | `price_report` (also feeds candles) |
| Positions opened | `MarketOpenExecuted`, `LimitOpenExecuted` | `position` |
| Positions closed | `MarketCloseExecutedV2`, `LimitCloseExecuted` | `closed_position` |
| Position updates (TP/SL, collateral) | `TpUpdated`, `SlUpdated`, `TopUpCollateralExecuted`, `RemoveCollateralExecuted` | `position` |
| Liquidations | `LimitCloseExecuted` with `orderType = LIQ` | `closed_position.close_reason = 'liq'` |
| LP deposits/withdrawals | `DepositRequestedV2`, `WithdrawRequestedV2`, `DepositClaimedV2`, `WithdrawClaimedV2` | `lp_activity` |
| Cancellations / timeouts (design §7 error table) | `MarketOpenCanceled`, `MarketCloseCanceled`, `AutomationOpenOrderCanceled`, `AutomationCloseOrderCanceled`, `MarketOpenTimeoutExecutedV2`, `MarketCloseTimeoutExecutedV2`, `RemoveCollateralRejected` | `order.status` |
| Market metadata | `PairAdded` (+ one bounded `pairs(uint16)` read), `PairMaxLeverageUpdated`, `PairFeedUpdated`, `MaxOpenInterestUpdated` | `market` |
| Candles (OHLCV) | derived from `PriceReceived` **and** every trade-execution event's price | `candle` |
| Indexer sync heartbeat | `blocks.ChainHeartbeat` (every block, chain 1874) | `sync_status` |

Files:
- `services/indexer/ponder.config.ts` — chains/contracts/block-interval config
- `services/indexer/ponder.schema.ts` — all 9 onchain tables (`onchainTable`)
- `services/indexer/abis/*.ts` — hand-transcribed, `as const` event ABIs
- `services/indexer/src/handlers/*.ts` — one file per contract
- `services/indexer/src/lib/*.ts` — pure helpers (`candleTick.ts`, `enums.ts`, `bytes32.ts`, `tradeId.ts`, `db.ts`)
- `services/indexer/src/api/index.ts` — minimal Hono stub (Ponder requires this file to boot at all; the indexer does not serve reads itself, see §2)
- `services/indexer/fixtures/*.json` — frozen real transaction receipts (§3)

### 1.2 `services/api/` — REST + WebSocket

Plain Node `http` server (no framework) + a hand-rolled path-param router (`src/router.ts`) +
`ws` for WebSocket. Reads directly from the same Postgres tables Ponder writes — no dependency
on the indexer process at runtime, matching the architecture diagram in the design spec (API and
indexer are separate `services/*` that both talk to Postgres).

Implemented exactly the surface requested:

```
GET  /health                          -> { status, chainId, indexedBlock, lagSeconds }
GET  /markets
GET  /markets/:pairIndex
GET  /markets/:pairIndex/candles      -> ?interval=1m|5m|15m|1h|4h|1d&from=<unix>&to=<unix>
GET  /positions/:address
GET  /positions/:address/history
GET  /orders/:address
GET  /price/:pairIndex
WS   /ws                              -> subscribe/unsubscribe: price:<pairIndex>,
                                          positions:<address>, orders:<address>,
                                          candles:<pairIndex>:<interval>
```

Files: `services/api/src/{server,router,db,format,ws}.ts`, `services/api/src/routes/*.ts`.

---

## 2. Contradiction found and resolved (not a spec conflict — a version conflict)

The design spec names Node 20 and the task's hard constraints say "Node 20". The **latest**
Ponder release (`0.17.x`, npm `latest` tag, published 2026-09-03) declares
`"engines": {"node": ">=22"}` — confirmed via `npm view ponder@0.17.9 engines`. The environment's
actual Node is `v20.18.1` (also what root `package.json`'s own `"engines": {"node": ">=22"}`
already disagrees with — a pre-existing mismatch, not something introduced here).

**Resolution:** pinned `ponder` to `0.16.10` (last version with `"engines": {"node": ">=18.14"}`,
confirmed via `npm view ponder@0.16.10 engines`), not the caret-latest. The `onchainTable`/
`createConfig`/`ponder.on` APIs used here have been stable since well before 0.16, so this is not
a downgrade in capability — it is a compatibility choice, stated explicitly rather than silently
picking whichever version installed. If the environment's Node is ever upgraded to 22, bumping to
`0.17.x` should be a routine version bump, not a rewrite.

`ponder start` also requires a `src/api/index.ts` file to boot at all in this version (a minimal
default-exported Hono app) — this was not documented as a "hard requirement" anywhere I read in
advance; discovered when `ponder start` failed with `BuildError: API endpoint file not found`.
Added a one-line stub (§1.1) since this indexer doesn't serve its own reads.

---

## 3. Event decoding verified against real chain data

Per the task's explicit ask, every signature used on the critical open/close path was checked
against real transactions, not assumed from the interface files alone. Method: `cast keccak
"<signature>"` for each candidate event, then matched the resulting `topic0` against the actual
logs returned by `eth_getTransactionReceipt` for the three real transactions in
`deployments/1874-operational.json` (`openTradeTx`, `openReportTx`, `closeTradeTx` via
`closeReportTx`), fetched directly from `https://rpc.testnet.whitechain.io`.

Two real findings from this process, both encoded into the ABIs and documented inline:

1. **The deployed contracts emit the V2 variants, not V1.** `PriceRequestedV2` (topic0
   `0x0b34af4d...`) fires, not `PriceRequested`; `MarketCloseExecutedV2` (topic0
   `0xcaa9acf3...`) fires, not `MarketCloseExecuted`. Confirmed by exact topic0 match against the
   real logs, not by reading the interface alone.
2. **`tradeId` is not a separate identifier anywhere in the event surface.** Neither
   `MarketOpenExecuted` nor `LimitOpenExecuted` emits a trade id — only the *open order's*
   `orderId`. The close events (`MarketCloseExecutedV2`, `LimitCloseExecuted`) reference a
   `tradeId`. Decoding the real close report (`closeOrderId=3`) shows `tradeId=2`, exactly equal
   to the real `openOrderId=2` from `deployments/1874-operational.json`. **Convention adopted:
   `tradeId === the open order's orderId`**, applied consistently in `position`/`closed_position`.
   Documented in `services/indexer/src/lib/tradeId.ts`. This is confirmed for **market** orders
   (the only kind that has executed on this testnet so far) and **inferred, not independently
   verified**, for limit/stop orders — flagged explicitly rather than silently assumed.

The exact decode, reproducing the task's required assertion:

```
$ cast abi-decode "f((uint256,uint192,uint192,uint192,address,uint32,uint16,uint8,bool,bool),uint256,uint256)" \
    <MarketOpenExecuted log data> --input
(999000000 [9.99e8], 65001000000000000000000 [6.5e22], ...)
```

`collateral=999000000`, `openPrice=65001000000000000000000` — exact match to
`deployments/1874-operational.json`'s `proofTrade.collateral` / `proofTrade.openPrice`.

`services/indexer/test/decode.test.ts` reproduces this offline (no network call at test time)
against frozen fixtures in `services/indexer/fixtures/*.json` (raw `eth_getTransactionReceipt`
responses, captured 2026-09-08), asserting the exact known values byte-for-byte.

Also independently confirmed the same way: `PairAdded` (from="BTC", to="USD", matching
`deployments/1874-operational.json`'s `market.from`/`market.to`) and `MaxOpenInterestUpdated`
(value=1,000,000,000,000, matching `market.maxOpenInterest` exactly).

One gap surfaced by this process: **`PairAdded` does not carry `feed`/`maxLeverage`/
`groupIndex`/`feeIndex`** — a direct `eth_getLogs` sweep for `PairMaxLeverageUpdated` and
`PairFeedUpdated` near the pair-configuration block found neither event either. The full `Pair`
struct only exists in contract storage. The `PairAdded` handler therefore does one bounded
`pairs(uint16)` `readContract` call to fill in the rest of the market row — a real, disclosed
RPC dependency, not a silent gap (see `services/indexer/src/handlers/pairsStorage.ts`).

---

## 4. Reorg safety

**The indexer does no reorg bookkeeping of its own.** Every table is defined with Ponder's
`onchainTable` (Drizzle-based schema API), and every write goes through `context.db.insert/
update/delete` inside `ponder.on(...)` handlers — nothing here manages block ranges, "canonical"
flags, or manual rollback logic.

**How this was verified — not just trusted from documentation:** ran `ponder start` (not `dev`)
against a real, disposable local Postgres (`initdb`/`pg_ctl` on this machine, no Docker) with
`DATABASE_URL` pointed at it, and let it sync live against `https://rpc.testnet.whitechain.io`
for chain 1874, from `startBlock=7284500` through the real proof-trade block range. Inspected the
resulting schema directly:

```
$ psql ... -d whitespace_test -c "\dt"
 _ponder_checkpoint | _ponder_meta      | _reorg__candle          | _reorg__closed_position
 _reorg__lp_activity | _reorg__market   | _reorg__order           | _reorg__position
 _reorg__price_report | _reorg__price_request | _reorg__sync_status
 candle | closed_position | lp_activity | market | "order" | "position" | price_report
 price_request | sync_status
```

Every single one of the 9 tables in `ponder.schema.ts` got a matching `_reorg__<table>` shadow
table created automatically, plus Ponder's own `_ponder_checkpoint`/`_ponder_meta` bookkeeping —
confirming Ponder's reorg-revert SQL (`revertOmnichain`, which deletes/re-inserts rows from the
reorg shadow tables back into the live tables when a reorg checkpoint is crossed) is wired up for
every table this indexer defines, with zero custom code from this project. This is the reorg
mechanism the design spec names ("Ponder unwinds reorgs natively").

**Not verified:** an actual live reorg occurring and being unwound was not observed — I did not
force one (1874 is a real, shared testnet; I have no way to trigger a reorg on it), and none
happened to occur during the sync window I ran. The verification above is structural (the
mechanism is provably wired up for every table) rather than a witnessed revert.

---

## 5. Decimal precision — how it's guaranteed end to end

1. **Storage.** Every price/collateral/notional column in `ponder.schema.ts` uses Ponder's
   `bigint` column type, which — confirmed via Ponder's docs and independently via `pg_dump`
   against a live-synced database (§4) — is backed by Postgres `numeric(78,0)`, not the 8-byte
   Drizzle default. `numeric(78,0)` holds any `uint256`/`int256` value exactly.
2. **Read path.** `node-postgres` (`pg`) returns `NUMERIC` and `BIGINT` columns as JavaScript
   **strings**, not numbers, by default. Confirmed directly (not assumed) against the live
   ephemeral Postgres instance:
   ```
   SELECT 65001000000000000000000::numeric -> typeof "string", value "65001000000000000000000"
   SELECT 999000000::bigint               -> typeof "string", value "999000000"
   SELECT 123::int                        -> typeof "number", value 123   (safe: int32 fits exactly)
   ```
3. **Formatting.** `packages/shared/src/decimal.mjs`'s `toDecimalString(raw, decimals)` does pure
   string/bigint manipulation — `BigInt(raw)`, digit-string padding, decimal-point insertion —
   and **never calls `Number()` or `parseFloat()`** on a monetary value. `services/api/src/
   format.ts` routes every response field that represents money through this function.
4. **Serialization.** All money fields are plain JSON strings (e.g. `"collateral":"999.000000"`),
   verified by regex-matching the raw HTTP response text (not just the parsed object) in
   `services/api/test/decimalEndToEnd.test.ts`, so a value that would silently corrupt through a
   float (`9007199254740993`, i.e. 2^53+1) is asserted to survive the full Postgres → HTTP → JSON
   round trip with its exact last digit intact, and a parallel assertion proves the naive
   float-based computation *would* have gotten that digit wrong (`...740992` vs the correct
   `...740993`) — so the test is a real discriminator, not a tautology.

Leverage (`PRECISION_2`) and other small integers are Postgres `integer` columns, which `pg`
returns as native JS `number` — safe, since `int32` always fits exactly in a `number`; this is
not a precision compromise, it mirrors the actual value range.

---

## 6. Design choices worth flagging explicitly

- **Candle volume is `collateral * leverage / 100` (quote notional, PRECISION_6), not the
  event's `tradeNotional` field.** Decoding the real `MarketOpenExecuted` log, `tradeNotional =
  153689943231642590`, and `9990 / 65001 ≈ 0.153689...` — strongly suggesting `tradeNotional` is
  **base-asset** (BTC) denominated at 18 decimals, not USDW quote notional. Rather than bet the
  volume metric on an inferred unit, `services/indexer/src/lib/candleTick.ts`'s `quoteNotional()`
  computes it directly and unambiguously from `collateral`/`leverage`, both of whose units are
  stated in the contract interfaces. This is a deliberate choice, not an oversight — flagged here
  per the "if design spec and on-chain reality contradict, stop and report" instruction, even
  though this isn't quite a contradiction (more a documentation gap the real data filled in
  unexpectedly).
- **Partial closes are not (yet) surfaced in `/positions/:address/history`.**
  `MarketCloseExecutedV2` has a `percentageClosed` field — closes can be partial, leaving the
  position open with reduced collateral. The indexer handles this correctly for the *position*
  (collateral is reduced in place, OI is adjusted proportionally, the position is **not**
  deleted) but does **not** write a `closed_position` row for a partial close, because that table
  models "this trade is over" and a partial close isn't that. A proper realized-PnL trail across
  multiple partial closes of the same `tradeId` would need a table keyed by `(tradeId, orderId)`
  rather than `tradeId` alone — scoped out given time, not silently dropped (see the code comment
  in `services/indexer/src/handlers/tradingCallbacks.ts`).
- **`GET /orders/:address` cannot show `collateral`/`leverage`/`buy` for a still-pending *open*
  order.** `MarketOpenOrderInitiated` (phase 1) doesn't carry the `Trade` payload — only
  `MarketOpenExecuted` (phase 2) does. Enriching this would need a `reqID_pendingMarketOrder`
  contract read per *every* open-order request (high frequency, unlike the one-off pair-config
  read), which was judged not worth the added RPC load for this phase. The fields are `null`
  rather than fabricated.
- **`GET /price/:pairIndex`'s `healthyVenues`/`degraded` are `null`, and `mark` mirrors `index`.**
  No `services/price-publisher` exists in this repository yet (that's phase 3 scope). Per the
  task's explicit instruction, this endpoint serves `index`/`mark`/`updatedAt` from the latest
  indexed `PriceReceived` report and returns `healthyVenues`/`degraded` as `null` — an honest
  "no data source for this" rather than an invented number.
- **RPC failover is implemented but effectively untested with two independent live endpoints.**
  `ponder.config.ts` wraps `viem`'s `fallback([...])` transport around a comma-separated
  `PONDER_RPC_URLS_1874` env var (default: the one documented public endpoint,
  `https://rpc.testnet.whitechain.io`). Only one real RPC endpoint for chain **1874** is known —
  the design spec's own chain-probe table only documents that one; `rpc-testnet.whitechain.io`
  (hyphen) is a **different chain (2625)** per the hard constraints and must not be substituted
  in. The failover mechanism is real and will pick up a second endpoint the moment one exists,
  but I did not fabricate a second endpoint to "prove" failover — that would be measuring against
  invented infrastructure.
- **WebSocket push is poll-based, not Postgres `LISTEN`/`NOTIFY`.** Ponder writes to Postgres with
  no built-in change-notification hook. Bolting on `LISTEN`/`NOTIFY` via custom triggers was
  considered, but whether those triggers interact safely with Ponder's own reorg-revert SQL
  (`DELETE`/`INSERT` against the live tables during a revert) was not something I could verify
  without observing a real revert (§4), so I chose not to add unverified triggers to tables Ponder
  owns. Instead, `services/api/src/ws.ts` polls each **actively subscribed** channel (poll
  interval configurable, default 2s, 30-50ms in tests) and only pushes when the computed payload
  actually changed since the last push. This is a real, disclosed limitation: sub-poll-interval
  updates coalesce, and there's no true push latency floor below the poll interval.
- **Open interest has no on-chain delta event.** `openInterestLong`/`openInterestShort` on
  `market` are accumulated by the indexer itself from `collateral*leverage` on every open/close
  event (not read via `eth_call`), since no `OpenInterestChanged`-style event exists on any of the
  contracts read.

---

## 7. Schema (Postgres, as created by Ponder from `ponder.schema.ts`)

All monetary/price/id columns are `numeric(78,0)` (exact-precision integers in base units);
`integer` columns are safe native ints (pairIndex, leverage's raw PRECISION_2 int, block-relative
counts); `text` for strings/hex/enums-as-labels; `boolean` for flags.

| Table | Key | Notes |
|---|---|---|
| `market` | `pair_index` | from/to/feed/oracle, `max_leverage` (PRECISION_2), `max_open_interest`/`open_interest_{long,short}` (PRECISION_6) |
| `price_request` | `order_id` | phase 1 of two-phase flow |
| `price_report` | `order_id` | phase 2; `price` PRECISION_18 signed; feeds candles |
| `order` | `order_id` | `kind` ∈ open/close/automation_open/automation_close/remove_collateral; `status` ∈ pending/executed/cancelled/timeout |
| `position` | `trade_id` | open positions; PK is `trade_id`, not the contract's `(trader, pairIndex, index)` slot — see §3 |
| `closed_position` | `trade_id` | `close_reason` ∈ close/tp/sl/liq/close_day_trade/... (from `IOstiumTradingStorage.LimitOrder`) |
| `lp_activity` | synthetic `id` | deposit/withdraw request + claim events |
| `candle` | synthetic `id` (`pairIndex-interval-bucketStart`) | one row per interval per bucket; OHLC PRECISION_18, volume PRECISION_6 |
| `sync_status` | `chain_id` | updated every block; backs `/health` |

Full DDL (captured live via `pg_dump --schema-only` against a real synced database, not
hand-typed) is in `services/api/test/fixtures/schema.sql`.

---

## 8. Tests and exact commands run

```
# packages/shared (decimal + candle bucket math) — pure functions, no DB, no network
$ node --test packages/shared/test/
# tests 22, pass 22, fail 0

# services/indexer — event decoding against real chain fixtures, candle tick aggregation,
# bytes32 NUL-stripping regression — no DB, no network at test time
$ cd services/indexer && npx vitest run
# Test Files  3 passed (3) | Tests  30 passed (30)

# services/indexer — TypeScript strict compile
$ cd services/indexer && npx tsc --noEmit
# (no output = clean)

# services/api — REST + WS against a REAL ephemeral Postgres (initdb/pg_ctl spun up by
# test/globalSetup.ts, torn down after)
$ cd services/api && npx vitest run
# Test Files  7 passed (7) | Tests  40 passed (40)

# services/api — TypeScript strict compile
$ cd services/api && npx tsc --noEmit
# (no output = clean)

# pre-existing suites, confirmed still green (nothing broken by this work)
$ node --test packages/reporter/test/     # tests 4,  pass 4
$ node --test tools/                      # tests 19, pass 19
```

**Total: 115 tests, all passing.** (22 shared + 30 indexer + 40 api + 4 reporter [pre-existing]
+ 19 tools [pre-existing].)

Additionally, and separately from the committed automated suite: ran `ponder start` twice against
disposable local Postgres instances, live-syncing against real Whitechain testnet 1874 RPC calls,
and inspected the resulting rows directly with `psql` (§3, §4). This is the strongest evidence in
this report — real chain data, decoded by this code, matching the known values in
`deployments/1874-operational.json` exactly:

```
closed_position: trade_id=2, trader=0x2b8ba090dedf879f8045c0dda5a78762ced90d19,
  close_price=64999000000000000000000, close_reason=close, percent_profit=-30768,
  usdc_sent_to_trader=998692628, percentage_closed=10000
market: pair_index=0, from_symbol=BTC, to_symbol=USD, max_leverage=10000,
  max_open_interest=1000000000000
```

This live run also caught and fixed a real bug: `hexToString()` on a Solidity `bytes32` string
leaves literal NUL (U+0000) padding characters, which Postgres `text` columns reject — Ponder
was silently sanitizing it with a `WARN Detected and removed null byte characters` log until
`services/indexer/src/lib/bytes32.ts` was fixed to strip them explicitly (regression test:
`services/indexer/test/bytes32.test.ts`). This is exactly the kind of bug that only a live
integration run — not the isolated unit tests — would have caught.

---

## 9. What was NOT verified

- **A real chain reorg being unwound.** Verified the mechanism is structurally wired up (§4) by
  inspecting the created schema; did not observe an actual revert, since none occurred during the
  sync windows run and reorgs on a shared public testnet can't be forced.
- **Full historical sync to chain head.** The public RPC endpoint rate-limits aggressively under
  this indexer's query volume (6 contracts × ~25 events ⇒ many distinct `eth_getLogs` filters per
  block range); live runs got to 39–52% backfill progress in the time available before being
  stopped deliberately, not because of a bug. The block range containing the real proof trade
  (7284578–7284716) was fully synced and verified correct in every run.
- **RPC failover with two genuinely independent live endpoints** — only one is documented/known
  to exist for chain 1874 (§6).
- **The live price-publisher / keeper / liquidator services** — none exist in this repo yet
  (phases 3/6). `/price`'s `healthyVenues`/`degraded` are honestly `null`, not simulated.
- **LP vault flows against real data.** `lp_activity` handlers are written and unit-testable, but
  no deposit/withdraw transaction occurred in the observed chain window, so this path has not
  been exercised against real chain data (only structurally, via the ABI/handler code).
  `IOstiumVault`'s events are complex (async settlement model) — the four events indexed
  (`{Deposit,Withdraw}RequestedV2`, `{Deposit,Withdraw}ClaimedV2`) are the request/claim points,
  not the full settlement lifecycle (`NewEpoch`, `SettlementExecuted`, MM deposit/withdraw are
  not indexed) — scoped out given time.
- **The limit/stop-order `tradeId === orderId` convention** — inferred by consistency with the
  market-order case (§3), not confirmed against a real limit-order execution (none exist yet on
  this testnet).
- **WS behavior under many concurrent subscribers / load.** Tests prove correctness (both
  directions of the subscribe/unsubscribe filter) at small scale, not throughput.
- **CI wiring.** `.github/workflows/ci.yml` was not modified to run the new
  indexer/api/shared test suites — out of this task's stated scope (build + test the services),
  left as a follow-up rather than a silent gap.
- **`services/indexer`'s own dev server (`ponder dev`)** was not run — only `ponder codegen` and
  `ponder start` (twice, live). `ponder dev`'s hot-reload path is additional surface not exercised.
- **No private keys were read, printed, logged, or needed anywhere in this work** — both services
  are strictly read-only against Postgres/RPC; grepped the diff for anything key-shaped before
  finishing and found nothing.

---

## 10. Postgres availability in this environment

Postgres **is** available locally (`psql`/`pg_ctl`/`postgres`/`initdb` binaries present,
version 16.13) — no Docker dependency needed. `services/api/test/pgHarness.ts` spins up a fully
disposable instance per test run (`initdb` into a fresh temp dir, `pg_ctl start` on a free port,
`psql` to create the DB and apply `test/fixtures/schema.sql`, `pg_ctl stop -m immediate` +
`rm -rf` on teardown) via Vitest's `globalSetup`. A `TEST_DATABASE_URL` env var override exists
for CI environments that provide a managed Postgres instead. Nothing in this project silently
skips DB-dependent tests when Postgres is present.
