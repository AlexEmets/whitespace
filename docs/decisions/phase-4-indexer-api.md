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

---

## 11. Orders, fees, PnL and settlements (2026-09-28, spec `2026-09-28-testnet-perfect-design.md` §9)

### 11.1 Indexer tables added

| table | key | written by |
|---|---|---|
| `limit_order` | `${trader}-${pairIndex}-${index}` (trader lowercase) | `OpenLimitPlacedV2` (insert/replace), `OpenLimitUpdated` (price/tp/sl), deleted by `OpenLimitCanceled` and `LimitOpenExecuted` |
| `order_event` | `${txHash}-${logIndex}` | one history row per limit action: `limit_placed`, `limit_updated`, `limit_cancelled`, `limit_executed` |
| `fee_charge` | `${txHash}-${logIndex}` (`-rollover`/`-funding` suffix for `FeesChargedV2`) | every fee event, see below |
| `liquidation` | close `orderId` | `VaultLiqFeeCharged` — lets the close handler tell a liquidating market close from a normal one |
| `vault_settlement` | `settlementId` | `AsyncDepositWithdrawExecuted` + `SettlementExecuted` merged |

What the contracts actually emit (read from the vendored sources, not the interfaces):

- Placing a limit/stop emits only `OpenLimitPlacedV2`; the V1 `OpenLimitPlaced` is never emitted.
  The event carries the full `Trade` and the `OpenOrderType`, so LIMIT vs STOP needs no storage read.
- `AutomationOpenOrderCanceled` does **not** remove the resting order — the callback only releases
  the trigger, the order stays in storage and can fire again. So `limit_order` keeps it.
- `LimitOpenExecuted.limitIndex` is the freed limit slot; `t.index` is the new trade's slot.
- `TpUpdated`/`SlUpdated` only apply to open trades; limit orders change tp/sl via `OpenLimitUpdated`.
- `RemoveCollateralRejected` is emitted by the **callbacks** with a `CancelReason` enum. The indexer
  used to subscribe to the `IOstiumTrading` declaration (string reason), which is never emitted, so a
  rejected remove-collateral order stayed `pending` forever. Fixed.
- A **market** close can liquidate. `MarketCloseExecutedV2` has no flag for it and reports the value
  the vault kept as `usdcSentToTrader`. `VaultLiqFeeCharged` fires first in the same callback, so the
  close is now stored as `closeReason: 'liq'`, `usdcSentToTrader: 0`. (A liquidation whose remaining
  value is exactly 0 emits no fee event; it stays `'close'` with 0 sent, which is still correct money.)

Fee kinds: `OracleFeeCharged` and `OracleFeeChargedLimitCancelled` → `oracle` (the latter has no
trade, `trade_id` null); `DevFeeCharged` → `dev`; `VaultOpeningFeeCharged` → `vault_opening`;
`VaultLiqFeeCharged` → `vault_liq`; `FeesChargedV2` → one `rollover` and one `funding` row, both
**signed** (the contract subtracts them from trade value, so positive = paid, negative = received),
zero amounts kept; `OracleFeeBondCharged` → `bond`. The bond path emits `OracleFeeCharged(bond)`
immediately followed by `OracleFeeBondCharged` (which has no amount), so the bond row takes the
preceding log's amount and that `oracle` row is deleted — the bond is counted once.
`BuilderFeeCharged` is not recorded (no builder on this deployment; not a spec kind).
`pair_index` comes from the position, else the open order (open-time fees fire before the position
row exists), else the closed position, else null.

`lp_activity` also gained `deposit_cancelled`, `withdraw_cancelled`, `deposit_reclaimed`,
`withdraw_reclaimed` and `deposit_refunded` (pro-rata cap refund).

Handler logic now lives in `src/lib/{limitOrders,fees,positions,vaultSettlement,lpActivity}.ts` and
is unit-tested against `test/fakeDb.ts`, an in-memory store keyed by each table's real primary key.
Every new ABI fragment's topic0 is checked against its Solidity signature in
`test/abiSignatures.test.ts`.

### 11.2 Endpoints added

Types are exported from `services/api/src/types.ts`. Money is a decimal string (prices 18 dp, USDW
6 dp, leverage 2 dp), ids are integer strings, addresses lowercase, times unix seconds. A malformed
address or `limit` answers `400 {"error": "..."}`.

`GET /limit-orders/:address` → `LimitOrder[]`, newest first:

```json
[{ "id": "0x2b8b…0d19-0-0", "trader": "0x2b8b…0d19", "pairIndex": 0, "index": 0,
   "orderType": "LIMIT", "buy": true, "collateral": "50.000000", "leverage": "10.00",
   "triggerPrice": "60000.000000000000000000", "tp": "70000.000000000000000000",
   "sl": "0.000000000000000000", "placedAt": 1788882000, "updatedAt": 1788882000,
   "placedTx": "0x…" }]
```

`GET /orders/:address/history?limit=100` (1–500) → `OrderHistoryEntry[]`, newest first — the `order`
table (oracle-flow orders, any age) merged with `order_event` (limit actions). A limit fill appears
both as its `automation_open` order and as `limit_executed`.

```json
[{ "source": "limit", "id": "0x…-3", "orderId": null, "kind": "limit_cancelled", "orderType": "STOP",
   "pairIndex": 0, "tradeId": null, "index": 1, "buy": false, "collateral": "25.000000",
   "leverage": "5.00", "price": "59000.000000000000000000", "tp": "0.000000000000000000",
   "sl": "61000.000000000000000000", "status": "cancelled", "cancelReason": null,
   "requestedAt": 200, "resolvedAt": 200, "txHash": "0x…" },
 { "source": "order", "id": "5", "orderId": "5", "kind": "open", "orderType": "MARKET",
   "pairIndex": 0, "tradeId": null, "index": null, "buy": null, "collateral": null, "leverage": null,
   "price": null, "tp": null, "sl": null, "status": "cancelled", "cancelReason": "slippage",
   "requestedAt": 100, "resolvedAt": null, "txHash": "0x…" }]
```

`kind`: `open | close | automation_open | automation_close | remove_collateral | limit_placed |
limit_updated | limit_cancelled | limit_executed`. `status`: `pending | executed | cancelled | timeout`
(limit rows: `cancelled` for `limit_cancelled`, else `executed`). `orderType` is `MARKET` for
`open`/`close`, the limit's type for limit rows, else null.

`GET /fees/:address?limit=200` (1–1000) → `FeeCharge[]`, newest first:

```json
[{ "id": "0x…-5-funding", "trader": "0x…", "tradeId": "2", "pairIndex": 0, "kind": "funding",
   "amount": "-1.234567", "at": 200, "blockNumber": "7285600", "txHash": "0x…" }]
```

`GET /pnl/:address` → `PnlSummary`, over closed positions:

```json
{ "realizedPnl": "49.692628", "fees": "1.250040", "funding": "-0.300000", "trades": 2 }
```

`realizedPnl` = Σ(usdcSentToTrader − collateral), the same figure `/positions/:address/history`
gives per trade. `fees` = Σ oracle + dev + vault_opening + bond + rollover on those trades;
`vault_liq` is excluded because it is the liquidated remainder, already a loss in `realizedPnl`.
`funding` is signed. Proceeds of **partial** closes are not in `closed_position` and so not in
`realizedPnl` (the pre-existing scope note above still applies).

`GET /vault/settlements?limit=50` (1–500) → `VaultSettlement[]`, newest first:

```json
[{ "settlementId": 4, "settlementType": "acct", "settlementTs": 1788880000,
   "totalAssets": "1000.000000", "totalSupply": "990.000000",
   "shareToAssetsPrice": "1.010000000000000000", "settlementOpenPnl": "-5.000000000000000000",
   "totalClosedPnl": "-3.000000", "accPnlPerTokenUsed": "-0.000000000000000012",
   "bufferSize": "0.000007", "assetsDeposited": "5.000000", "sharesWithdrawn": "15.000000",
   "deltaShares": "-10.000000", "at": 1788880001, "blockNumber": "7285000", "txHash": "0x…" }]
```

Columns a settlement's other event has not filled yet are null (`shareToAssetsPrice` never is).

WebSocket: `limitOrders:<address>` and `fees:<address>` push exactly the REST payloads (same
resolvers; `fees` is the 200 newest).

### 11.3 WebSocket bounds

The poll re-queries every subscribed channel every 2 s. `positions:<address>` ran an unbounded
`SELECT` per wallet and any string was accepted as a wallet, so a client could create any number of
distinct polled channels. Now: positions come from `resolvePositions` (shared with REST, capped at
500 rows), every wallet channel (`positions`, `orders`, `limitOrders`, `fees`) requires a
well-formed address, and one socket may hold at most 64 subscriptions (the 65th gets
`{type: "error"}`).

### 11.4 Partial closes, percentProfit, address validation

- **Partial closes.** The indexer's `partial_close` table (key: close `orderId`) records each
  partial market close: the collateral closed (`collateral × percentageClosed / 10000`, what
  `TradingStorage.unregisterTrade` removes), close price, `usdcSentToTrader` (0 and
  `closeReason: 'liq'` when `VaultLiqFeeCharged` marked it) and `percentageClosed`. This
  supersedes the partial-close scope note earlier in this document.
  `GET /positions/:address/history` returns `PositionHistoryEntry[]`: full closes and partial
  closes merged, newest first. Each row gains `closeOrderId` (the unique key; `tradeId` repeats
  across a trade's partial and final closes), `closeTxHash`, `percentageClosed` ("25.00",
  "100.00") and `isPartial`. On partial rows `collateral` is the part closed and `tp`/`sl` are null.
  `GET /pnl/:address` sums both; `trades` is now the number of distinct trades that realised
  anything, and fees/funding cover all of those trades.
- **percentProfit** is a signed percent with 6 decimals (`getTradeValuePure` applies it as
  `collateral × p / 1e6 / 100`). It was formatted at 18 dp, i.e. 1e12 too small; the proof
  trade's raw −30768 now reads "-0.030768" (−0.030768 %, which is −0.307372 USDW on 999).
- `/orders/:address`, `/positions/:address` and `/positions/:address/history` answer
  `400 {"error": "invalid address"}` for anything that is not a 20-byte hex address.
