# Phase 6 decisions — liquidator and monitoring

> **2026-09-28 update:** `services/liquidator` is now the automation bot for liquidations,
> TP, SL and LIMIT/STOP entries. See **§11**. It replaces the log-discovered position
> table in §5 and the LIQ-only engine in §1. The redeploy deploys `OstiumTradesUpKeep`
> with two forwarders, which closes the gap in §2.6. §2–§4 (margin maths, recovery window,
> degraded-mode reasoning) still apply.

Status: **margin engine, decision logic and monitoring implemented and unit-tested;
never run against live RPC and no on-chain transaction was sent.** Nothing under
`contracts/`, `services/keeper/`, `services/price-publisher/`, `packages/reporter/` or
`packages/shared/` was modified (verified with `git status`; the only tracked-file
change anywhere in the repo is `pnpm-lock.yaml` from the required `pnpm install`).

**Two contract-side findings below are load-bearing and need an explicit decision before
this service can liquidate anything on live 1874 — read §2 before assuming phase 6 is
"done" in the sense of "liquidation fires automatically" (the phase 9 gate in the design
spec). Everything else (the margin math, the recovery window, degraded mode, monitoring)
is complete and exercised by 46 passing tests.**

---

## 1. What was built

```
packages/metrics/                        NEW package, additive only
  src/registry.mjs   Counter/Gauge + Prometheus text-exposition render(). Dependency-
                     free, no timers/IO. Deliberately its own package (not under
                     services/liquidator) so services/keeper and services/price-
                     publisher can import it later without depending on the
                     liquidator — see §6.
  test/registry.test.mjs   6 tests

services/liquidator/src/
  marginEngine.mjs   pure bigint mirror of OstiumPairInfos' margin/liquidation math
                     (see §2 for exactly what it mirrors and where it can diverge)
  sequencerLiveness.mjs   the recovery-window state machine (§3)
  degradedMode.mjs   the liquidator's own do-not-liquidate-while-degraded gate (§4)
  positionTable.mjs  candidate (trader,pairIndex,index) tracker, reorg-safe by
                     construction (§5)
  liquidatorEngine.mjs   orchestrates the above into one per-candidate decision;
                     every dependency (chain reads, submission) is injected, so this
                     is the fully-mocked, no-network core of the test suite
  performData.mjs    pure ABI encoding of OstiumTradesUpKeep.performUpkeep's payload
  abi.mjs            ABI fragments read from contracts/src/vendor/ostium/interfaces/*
                     (read-only reference; nothing under contracts/ written)
  chainReader.mjs    live eth_call wiring for the engine's injected readers (NOT
                     unit-tested — network; the logic it feeds is)
  txSender.mjs       legacy type-0 send to OstiumTradesUpKeep, nonce cache, 1.2x gas
                     bump, dead-letter — same shape as services/keeper/src/txSender.mjs
                     for the same failure domain, not imported from it (see §7)
  deadLetter.mjs     in-memory + optional file-persisted queue, liquidator's own
  rpc.mjs            viem fallback() transport across configurable RPC endpoints
  watcher.mjs        pure toOpenEvent + watchOpenEvents (RPC) for candidate discovery;
                     watchLiveness polls block number for both the sequencer monitor
                     and a simple reorg guard
  metrics.mjs        the specific instrument set (see §8)
  healthServer.mjs   node:http: GET /health, GET /metrics
  config.mjs, main.mjs

services/liquidator/test/
  marginEngine.test.mjs        10 tests
  sequencerLiveness.test.mjs    6 tests
  degradedMode.test.mjs         4 tests
  positionTable.test.mjs        6 tests
  liquidatorEngine.test.mjs     9 tests
  performData.test.mjs          3 tests
  txSender.test.mjs             3 tests
  watcher.test.mjs              2 tests
  healthServer.test.mjs         3 tests
```

---

## 2. The margin formula, and exactly where it can diverge

### 2.1 What the contract actually checks (read from source, not assumed)

The real on-chain liquidation trigger is **not** `getTradeLiquidationPrice`. Grepping the
vendor tree, `getTradeLiquidationPrice`/`getTradeLiquidationPricePure`
(`OstiumPairInfos.sol:775-825`) are never called from the trigger path at all. The actual
check, in `OstiumTradingCallbacks.executeAutomationCloseOrderCallback:504`:

```solidity
bool isLiquidated = tvResult.tradeValue < tvResult.liqMarginValue;
```

where `tvResult` comes from `TradingCallbacksLib.getTradeAndPriceData` →
`pairInfos.getTradeValue(...)`, and `getAutomationCloseOrderCancelReason` (for
`LimitOrder.LIQ`) resolves `CancelReason.NONE` (proceed) exactly when
`usdcSentToTrader == 0`, i.e. exactly when `isLiquidated` was true. So the contract's own
definition of "liquidatable" is:

```
tradeValue    = collateral + collateral*percentProfit/1e6/100 - rolloverFee - fundingFee   (floored at 0)
liqMarginValue = collateral * liqMarginThresholdP * leverage / maxLeverage / 100
liquidatable  = tradeValue < liqMarginValue                                                  (strict)
```

`percentProfit` comes from `TradingCallbacksLib._currentPercentProfit`, using the
**raw reported price** (`a.price`, not price-impact-adjusted) whenever
`orderType ∈ {LIQ, SL}` (`isMarketPrice = true` in
`executeAutomationCloseOrderCallback:492`) — confirming that comparing our own trusted
index/mark price directly, with no price-impact adjustment, is the correct basis.

### 2.2 `services/liquidator/src/marginEngine.mjs` mirrors this exactly

`getTradeLiquidationMargin`, `currentPercentProfit`, `getTradeValuePure`,
`isLiquidatable`, `getTradeFundingFeePure` are line-for-line bigint translations of
`OstiumPairInfos.sol`/`TradingCallbacksLib.sol`, including the exact left-to-right chain
of truncating `*`/`/` operators (Solidity's `/` truncates toward zero for both `int` and
`uint`; JS `BigInt`'s `/` does the same, verified for negative operands too). Boundary
tests (`test/marginEngine.test.mjs`) pin the strict-`<` semantics: a position exactly at
the margin threshold is **not** liquidatable.

**Decimal exactness against real numbers, not invented ones.** The test
`18/6/2 decimal scaling proven exact against the real deployed BTC/USD trade` uses the
actual executed trade in `deployments/1874-operational.json` (`openPrice`, `collateral`,
`leverage`) and the actual deployed `liqMarginThresholdP = 25` (from
`contracts/script/Deploy.s.sol`'s `LIQ_MARGIN_THRESHOLD_P`), computed independently with
a one-off bigint script (not by calling this module) to get:
`liqMarginValue = 24_975000n`, long liquidation price `58663_402500000000000000n`, short
`71338_597500000000000000n` — then asserts the module's output equals those literals.

### 2.3 The production reader does not replay fee accrual off-chain

`rolloverFee`/`fundingFee` accrue via a Hill-function funding curve and a Padé/
power-of-two fixed-point exponential approximation over per-block state
(`OstiumPairInfos.sol:561-716`) — exactly the kind of numerically delicate machinery this
project's own history warns against reimplementing (`.claude/tasks/lessons.md`-adjacent:
"a wrong exponent never reverts, it liquidates at the wrong price"). Instead
`chainReader.mjs` reads the exact live values via the contract's own `view` functions —
`pairInfos.getTradeRolloverFee(...)` and `pairInfos.getTradeFundingFee(...)` — and feeds
them into the same pure `getTradeValuePure`/`getTradeLiquidationMargin` used in the tests.
The only input not read byte-exact from the contract is the current price itself, which
is unavoidable and correct: that is precisely the two-phase oracle's job.

### 2.4 Where this can still diverge — stated plainly

1. **Staleness between decision and execution.** The margin check is exact *at the block
   it is evaluated*. By the time a submitted LIQ trigger's report round-trips (one to a
   few blocks at 1s/block), fees may have accrued further and price may have moved. The
   callback re-evaluates via the *exact same mechanism* at execution time, so the worst
   outcome is a harmless `CancelReason.NOT_HIT` rejection (gas spent, nothing executed),
   never a wrongful liquidation — the contract is always the final arbiter.
2. **`getTradeLiquidationPrice` is not bit-exact with the real trigger.** Found while
   building this (see `marginEngine.mjs`'s header note 0 and the test
   `isLiquidatableByPrice documents its divergence from isLiquidatable at the exact
   boundary`): plugging `getTradeLiquidationPricePure`'s own output back through the
   forward pipeline (price → percentProfit → tradeValue) gives `tradeValue ==
   liqMarginValue` exactly at that price for the tested fixture — i.e. **not yet**
   liquidatable by the strict-`<` contract rule, while a naive `price <= liquidationPrice`
   comparison would say it is. This is used only as a cheap local pre-filter
   (`isLiquidatableByPrice`), never as the submission decision — the exact value-based
   predicate always gates submission (`liquidatorEngine.mjs`). Both directions of the
   pre-filter's disagreement are safe to act on speculatively for the same reason as
   point 1.
3. **`maxLeverage` resolution.** `TradingCallbacksLib.getEffectiveMaxLeverage` branches on
   `isDayTrade` (day trades use `pairMaxLeverage`; overnight trades use
   `pairOvernightMaxLeverage` if set, else fall back). BTC/USD and ETH/USD are 24/7 crypto
   markets (design spec §1), so `isDayTrade` is expected false and
   `pairOvernightMaxLeverage` expected 0 for the launch markets — `chainReader.mjs`
   still resolves this per-trade rather than assuming it.
4. **`liqMarginThresholdP` is governance-mutable.** Read fresh each cycle
   (`pairInfos.liqMarginThresholdP()`), never cached indefinitely.

---

## 2.5 CONTRADICTION FOUND — liquidation is not permissionless as currently wired

The design spec (§5.3, §7) states liquidation is "permissionless with a reward" —
explicitly framed as both a decentralization property and redundancy for when the
project's own liquidator is down. Reading the actual access-control chain contradicts
this:

- `OstiumTrading.executeAutomationOrder` (the only entry point for LIQ/TP/SL/limit-open
  execution) is gated `onlyTradesUpKeep` — only the contract registered at registry key
  `'tradesUpKeep'` may call it (`OstiumTrading.sol:565-571`, `_onlyTradesUpKeep` at
  line 121-125).
- `OstiumTradesUpKeep.performUpkeep` (the only way to reach `executeAutomationOrder`) is
  gated `isForwarder[msg.sender]` (`OstiumTradesUpKeep.sol:54-57`) — an allowlist set only
  by the timelock owner via `registerForwarder`, the identical Chainlink-Automation-style
  forwarder pattern already used for the price-upkeep keeper (design spec §4.2 change #2:
  "Chainlink Automation forwarder → own keeper allowlist").

So execution requires holding a registered forwarder key on `OstiumTradesUpKeep` — it is
gated the same way ordinary order execution is, not open to arbitrary callers. This
service is built to participate as **one forwarder among possibly several** (never
assuming exclusivity, exactly as instructed — see the "lost race" tests), which is a
weaker but still real decentralization property (multiple independently-operated keys
can each be registered), but it is not literally "anyone can call this and collect a
reward" as the spec's language implies.

**Not resolved by this phase** (contracts/ is out of scope — a concurrent agent owns
it): whether to (a) accept "permissionless among registered forwarders" as the intended
reading, (b) register multiple independent forwarder keys as the redundancy mechanism,
or (c) add a genuinely public trigger entry point as a new contract, following the same
pattern D1 already established for the hardened verifier (`contracts/src/oracle/
Whitespace*.sol`, new files, vendor tree untouched). This needs an explicit decision,
not a guess — flagged per the task's own instruction rather than silently building
around it.

## 2.6 GAP FOUND — `OstiumTradesUpKeep` is not deployed on 1874 at all

`deployments/1874.json`'s `contracts` object has no `tradesUpKeep` key.
`contracts/script/Deploy.s.sol:215-229` registers exactly 9 contracts in the registry —
`tradingStorage, pairsStorage, pairInfos, trading, callbacks, vault, openPnl,
priceRouter, ostiumVerifier` — `tradesUpKeep` is not among them, and is never deployed
anywhere in the script. `registry.getContractAddress('tradesUpKeep')` therefore reverts
`NotFound` (`OstiumRegistry.sol:118-120`).

**Consequence: no address — this liquidator or any other — can execute an on-chain
liquidation against 1874 today.** This is independent of anything built in this phase.
`services/liquidator/src/config.mjs` reflects this honestly: `tradesUpKeepAddress` is
left `undefined` unless explicitly configured (rather than guessing a placeholder), and
`main.mjs`'s `submitLiquidation` fails loudly with `tradesUpKeep_not_configured` instead
of silently no-op'ing. Deploying and registering `OstiumTradesUpKeep`, then registering
this service's forwarder key, is a deploy-side prerequisite outside this phase's allowed
scope (`contracts/` and its deploy scripts are owned by a concurrent agent).

---

## 3. Sequencer liveness recovery window (`sequencerLiveness.mjs`)

1874 has no dedicated sequencer-uptime oracle (unlike Chainlink's feed on Arbitrum,
explicitly called out as absent in design spec §6.5). The only available liveness signal
is L2 block production itself: if the sequencer stalls, no new blocks are produced (no
fallback producer), so "no new block for longer than a threshold" is used as the stall
proxy.

State machine (`SequencerState`): `LIVE → STALLED → RECOVERING → LIVE`, with a stall
mid-recovery falling back to `STALLED` and the recovery window restarting from scratch
on the next resumption (no partial credit for a flapping sequencer).

Named constants (never magic numbers at the use site, per this repo's own convention in
`packages/shared/src/bounds.mjs`):

| Constant | Value | Basis |
|---|---|---|
| `SEQUENCER_STALL_THRESHOLD_MS` | 30,000 (30 s) | 30x the chain's measured 1.00 s block time (design spec §2.1) — wide enough to avoid false positives from ordinary jitter |
| `SEQUENCER_RECOVERY_WINDOW_MS` | 3,600,000 (1 h) | Mirrors the grace-period convention in Aave's Arbitrum sequencer-uptime integration (`GRACE_PERIOD_TIME = 3600` seconds) — a documented starting point, **not tuned against any observed outage on this chain** (none has occurred) |

Both are starting points explicitly, matching the design spec's own framing of its
initial parameters ("starting points to be tuned against measured data", §5.2) — tune in
phase 7 if real incident data becomes available.

**Both directions tested**, per the task's own warning that a one-directional test
cannot distinguish a working window from one that blocks forever:
`recovery window BLOCKS liquidation for its full duration after blocks resume` and
`recovery window ALLOWS liquidation once it has fully elapsed`, plus a flapping-stall
test proving the window restarts rather than accumulating partial progress.

**Caveat on the block-number proxy**: a same-height reorg (block number does not move
backward) would not be caught by this signal alone. `positionTable.mjs`'s live-re-read
requirement (§5) is the actual backstop against acting on such a case, not this monitor.

---

## 4. Degraded mode (`degradedMode.mjs`)

Design point 4 asked for an explicit decision, documented. Decision: **suppress all new
liquidation submissions below `MIN_HEALTHY_VENUES` (3) healthy venues, full stop** — even
though liquidation is technically a forced "close", and the publisher's own do-not-sign
gate (`services/price-publisher/src/aggregator.mjs`'s `canSignForOrderType`) explicitly
permits signing `LIMIT_CLOSE` reports while degraded (correct for an ordinary trader
wanting to exit, who must never be trapped).

**Why this matters concretely, not just "the spec said so":** a LIQ trigger's price
request uses `OrderType.LIMIT_CLOSE` (`OstiumTrading.sol:624-631`, confirmed by reading
the exact ternary), which is *not* in `OPEN_ORDER_TYPES` — so the publisher **will**
happily sign a report for a liquidation while degraded. Nothing else in the pipeline
stops it: the contract itself has no venue-health awareness at all. This module is
therefore the one and only backstop, and it defaults to the safe direction (never
liquidate on a suspect price) rather than the permissive direction, exactly as
instructed.

---

## 5. Position table and reorg handling (`positionTable.mjs`)

`services/indexer` does not exist yet in this repo snapshot (phase 4 is listed
"in progress" alongside this phase in the plan doc) — there is no indexer to source a
position table from. Rather than block on that or half-build a competing indexer, this
service discovers candidates directly from `MarketOpenExecuted`/`LimitOpenExecuted` logs
on `OstiumTradingCallbacks` (log-based, matching the design spec's own §2.4 constraint
that the public RPC has no `debug_traceTransaction`/`trace_block`), keyed by
`(trader, pairIndex, index)` — the same identity `executeAutomationOrder` itself takes,
so no `tradeId` correlation with close events is needed at all.

**The table is a poll list, not a source of truth.** Every margin decision
(`liquidatorEngine.evaluateOne`) re-reads live on-chain state
(`tradingStorage.getOpenTrade`) immediately before deciding. This is what makes the
design reorg-safe *by construction*, not by careful bookkeeping: a candidate discovered
from a log that turns out to be on an orphaned fork simply reads back `leverage === 0`
(an empty slot) on the next live poll and is skipped — it can never cause a wrongful
liquidation, only a wasted read. `pruneFromBlock` additionally drops candidates
discovered at or after a detected reorg point proactively (tested), so orphaned entries
don't linger in the poll set indefinitely, but this is defense in depth, not the safety
property itself.

---

## 6. Monitoring (`packages/metrics/`, `services/liquidator/src/metrics.mjs`)

A small, dependency-free Prometheus-text-exposition registry (`Counter`/`Gauge`/
`render()`) lives in its own new package, `packages/metrics/`, specifically so
`services/keeper` and `services/price-publisher` can depend on it later **without**
depending on the liquidator — the task's explicit requirement. Per the hard constraints,
neither of those two services was modified to actually emit metrics (that would touch
files outside this phase's scope); this is a purely additive capability. The two-line
integration each would need, if picked up later: add `"@whitespace/metrics": "workspace:*"`
to its `package.json`, then `const registry = createRegistry(); const c =
registry.counter(...)` at the relevant call sites (e.g. `txSender.mjs`'s retry loop,
`deadLetter.mjs`'s `add`).

Instruments actually wired in `services/liquidator/src/metrics.mjs`, covering every
signal the task listed: `liquidator_positions_tracked`,
`liquidator_positions_below_maintenance`, `liquidator_liquidations_attempted_total`,
`liquidator_liquidations_won_total`, `liquidator_liquidations_lost_race_total`,
`liquidator_liquidations_suppressed_degraded_total`,
`liquidator_liquidations_suppressed_sequencer_total`, `liquidator_oracle_staleness_ms`,
`liquidator_sequencer_state` (0/1/2 = LIVE/STALLED/RECOVERING),
`liquidator_rpc_healthy{endpoint=...}`, `liquidator_dead_letter_depth`. Served at
`GET /metrics` (Prometheus text) and `GET /health` by `healthServer.mjs`.

---

## 7. Reuse of `services/keeper` — what was and wasn't needed

**Zero changes to `services/keeper/`, confirmed by `git status`.** More importantly, zero
changes were *needed*, and the reason is structural, not just a constraint being obeyed:

`OstiumTrading.executeAutomationOrder`'s price request for a LIQ trigger calls
`priceRouter.getPrice(pairIndex, OrderType.LIMIT_CLOSE, priceTimestamp)`
(`OstiumTrading.sol:624-631`) — the identical `PriceRequestedV2` event, on the identical
`priceUpKeep` contract address, that every other order type already produces. The
existing keeper's watcher is already generic across `orderType`
(`services/keeper/src/watcher.mjs`'s `toPriceRequestedEvent` maps all five enum values;
`orderTypeName(3) === 'LIMIT_CLOSE'` was already supported). So once
`OstiumTradesUpKeep` exists and this service submits a LIQ trigger, the unmodified
keeper will pick up the resulting price request and deliver a signed report exactly as
it does for a trader's own close — no keeper-side branch, no keeper-side awareness that
a liquidation is happening at all.

What genuinely needed new code, because the keeper has no equivalent: submitting the LIQ
*trigger* itself (`txSender.mjs`, targeting `OstiumTradesUpKeep.performUpkeep` with a
`SimplifiedTradeId[]` payload — a different contract, different ABI, different payload
shape from the keeper's price-report delivery). This is new functionality, not a
reimplementation of report delivery.

---

## 8. Tests — commands and output

Focused runs while iterating, full suite once at the end, per the task's own guidance.

```
$ cd services/liquidator && node --test test/
# tests 46
# pass 46
# fail 0

$ cd packages/metrics && node --test test/
# tests 6
# pass 6
# fail 0
```

Full monorepo suite (every package/service with a `test/` dir), run after all changes,
confirming nothing else regressed:

```
packages/shared          18 pass / 0 fail
packages/reporter        13 pass / 0 fail
packages/metrics          6 pass / 0 fail
services/keeper          21 pass / 0 fail
services/price-publisher 58 pass / 0 fail
services/liquidator      46 pass / 0 fail
tools                     19 pass / 0 fail
------------------------------------------
total                   181 pass / 0 fail
```

Coverage against the task's explicit minimum list:

| Requirement | Test(s) |
|---|---|
| Exactly at / just above / just below maintenance margin | `marginEngine.test.mjs`: `boundary (long)` ×3, `boundary (short)` ×1 (all three positions in one test), plus `liquidatorEngine.test.mjs`'s `exactly at the maintenance boundary is NOT submitted` |
| 18/6/2 decimal scaling exact against a known value | `marginEngine.test.mjs`: `18/6/2 decimal scaling proven exact against the real deployed BTC/USD trade` (uses `deployments/1874-operational.json`'s real proof trade + the real deployed `liqMarginThresholdP`) |
| Recovery window blocks during, allows after (both directions) | `sequencerLiveness.test.mjs`: `recovery window BLOCKS liquidation for its full duration after blocks resume` and `recovery window ALLOWS liquidation once it has fully elapsed`, plus a flapping-restart test |
| Degraded mode suppresses liquidation | `degradedMode.test.mjs` (4 tests) + `liquidatorEngine.test.mjs`'s `degraded mode ... blocks submission, even for a liquidatable position` |
| Lost race handled without corrupting state | `liquidatorEngine.test.mjs`: `a lost race (position already closed by someone else) is handled cleanly: no submission, no throw, no state corruption`, plus `a submission that fails ... is recorded, not thrown, and not counted as won` |

All unit tests run with `node --test`, no network — every RPC/HTTP dependency is
injected and mocked (`liquidatorEngine.test.mjs`, `txSender.test.mjs`) or is genuine
local-loopback-only I/O (`healthServer.test.mjs`, matching
`services/price-publisher/test/server.test.mjs`'s own precedent for what counts as
"not network" in this repo).

---

## 9. What was NOT verified

- **No live RPC call was made.** `chainReader.mjs`, `rpc.mjs`, `watcher.mjs`'s live
  wrappers, and `main.mjs` were checked with `node --check` (syntax) and by running
  `main.mjs` far enough to prove config loading and RPC client construction succeed —
  it then fails, correctly and loudly, on the expected missing
  `~/.whitespace-keys/liquidator.json` (no such key exists; none was created, per the
  hard constraint against ever touching private keys). Beyond that point (event
  subscriptions, `eth_call`s, the sweep loop) nothing was exercised against the real
  chain.
- **No on-chain transaction was sent or attempted**, liquidation or otherwise. There is
  no unhealthy position on 1874 to liquidate, gas is not replaceable (CAPTCHA-gated
  faucet), and — independent of both of those — `OstiumTradesUpKeep` is not deployed, so
  no such transaction could succeed even as a test.
  the `~/.whitespace-keys/liquidator.json` role key does not exist; none was created.
- **`getTradeRolloverFee`/`getTradeFundingFee`'s live behavior** (the exact-fee-read
  path described in §2.3) was verified by reading the Solidity and confirming the
  functions are `public`/`external view` with no access-control modifier — not by
  actually calling them against a live or forked chain.
- **The publisher `/status` response shape** `chainReader.mjs` depends on
  (`feeds[feed].mark`, `feeds[feed].healthyCount`) was verified by reading
  `services/price-publisher/src/server.mjs`'s source directly, not by making a real
  HTTP request to a running publisher instance.
- **`packages/metrics` was not integrated into `services/keeper` or
  `services/price-publisher`** — by design, per the hard constraint against modifying
  those beyond additive exports; see §6 for the two-line integration path.

---

## 10. Summary of contradictions/gaps flagged (per the task's explicit instruction)

1. **§2.5** — liquidation is gated by the same forwarder allowlist as ordinary order
   execution (`OstiumTradesUpKeep.performUpkeep` → `isForwarder[msg.sender]` →
   `OstiumTrading.executeAutomationOrder`'s `onlyTradesUpKeep`), not "permissionless"
   in the literal sense the design spec's language (§5.3, §7) implies. Needs a decision,
   not a guess.
2. **§2.6** — `OstiumTradesUpKeep` is not deployed or registered on 1874 at all
   (`deployments/1874.json`, `contracts/script/Deploy.s.sol` both confirm this by
   omission). No liquidation can execute on-chain today regardless of this service.
3. **§2.4 point 2** — `getTradeLiquidationPrice` is a separately-derived, non-bit-exact
   approximation of the real trigger condition, not literally callable-and-trust-it. Not
   a contract bug — a genuine trap for anyone who assumes a view function named
   "LiquidationPrice" is the source of truth. Documented and worked around (§2.3), not a
   blocker, but worth the concurrent contracts agent's awareness since a future UI
   showing "your liquidation price" from this function is a display approximation, not
   an exact guarantee.
4. **§5** — no `services/indexer` exists yet to source a position table from (design
   spec's own §5.3 wording). Worked around with a direct, log-based, swappable candidate
   source; not a blocker, but means this phase's "position table" is not literally what
   §5.3 describes until phase 4 lands.

---

## 11. The automation bot (2026-09-28, design spec `2026-09-28-testnet-perfect-design.md` §4, §6, §9.3)

`OstiumTradesUpKeep.performUpkeep` is the only way into `OstiumTrading.executeAutomationOrder`,
and that one entry point serves LIQ, TP, SL and resting LIMIT/STOP entries. A bot that only
liquidated would leave the other three order types unexecuted, so `services/liquidator` now
triggers all four.

### 11.1 Shape of one sweep

```
indexer Postgres  --(position, limit_order; every sweep)-->  candidates
publisher /status --(once per sweep)-->                      price, bid, ask, venue health
per candidate (isolated: one failing read skips that candidate only):
    cooldown?  -> skip without chain reads where possible
    re-read the slot from chain (getOpenTrade / getOpenLimitOrder); gone -> lost race
    decide with the contract's own rule on the CHAIN values (triggerRules.mjs)
    gate per kind (degradedMode.canTrigger)
    skip if the contract would return BACKDATED / NO_TP / NO_SL / PENDING_TRIGGER
dedupe by (trader, pair, index, kind) -> batches of <= LIQUIDATOR_MAX_BATCH_SIZE -> sendPerformUpkeep
```

| Module | Role |
|---|---|
| `candidateSource.mjs` | `SELECT` from `position` and `limit_order` (spec §9.1). No state kept between sweeps, so a restart sees everything. A missing `limit_order` table (indexer not yet upgraded) is reported (`liquidator_limit_order_table_available 0`, one log line) and liquidations carry on. Any other DB error fails the sweep rather than acting on a partial view. |
| `chainReader.mjs` | Contract views + one publisher `/status` per sweep. Normalises viem's `number`-typed small ints to `bigint`. |
| `priceImpact.mjs` | Transcription of `TradingCallbacksLib.getDynamicTradePriceImpact` and helpers (same as `apps/web/src/lib/priceImpact.ts`), needed because TP and LIMIT compare the fill price after impact. |
| `triggerRules.mjs` | The hit conditions, below. Pure. |
| `automationEngine.mjs` | The sweep: re-read, decide, gate, dedupe, batch, cooldown, batch isolation, metrics. |
| `sweepLoop.mjs` | Single-flight scheduler: the next sweep starts `LIQUIDATOR_POLLING_INTERVAL_MS` after the previous one ends. |
| `txSender.mjs` | The only sender, behind one function `sendPerformUpkeep({ trades, timestamp })`. `packages/txsender` replaces it at merge. |
| `main.mjs`, `lifecycle.mjs`, `config.mjs` | Env-only config, SIGTERM drains the in-flight sweep, exit 1 on a fatal start. |

### 11.2 Trigger rules (what the bot fires, and on which price)

The report carries `price` = publisher mark and `bid`/`ask` = the aggregated index quote
(each falling back to the mark), exactly as `services/price-publisher` `engine.signReportFor`
builds it. Paths are `contracts/src/vendor/ostium/`.

| Kind | Hit when | Price compared | Source |
|---|---|---|---|
| LIQ | `tradeValue < liqMarginValue` (strict) | `price` | `OstiumTradingCallbacks.sol:534-546`, `lib/TradingCallbacksLib.sol:411-414` |
| SL long / short | `sl > 0 && price <= sl` / `price >= sl` | `price` | callbacks `:534-535` (isMarketPrice), lib `:419-422` |
| TP long / short | `tp > 0 && fill >= tp` / `fill <= tp` | fill after impact, closing (`isOpen=false`): the **bid** for a long, the **ask** for a short when `priceImpactK == 0` | lib `:278-279`, `:415-418` |
| LIMIT buy / sell | `fill <= target` / `fill >= target` | fill after impact, opening, sized on `calculatePostFeeCollateral`: the **ask** for a buy, the **bid** for a sell when `priceImpactK == 0` | callbacks `:443-450`, lib `:364-365` |
| STOP buy / sell | `price >= target` / `price <= target` | `price` | lib `:364-366` |

Also mirrored so the bot does not waste a trigger:

- a hit entry whose fill already crosses its own TP/SL is cancelled `TP_REACHED`/`SL_REACHED` (lib `:370-378`): not triggered;
- any of price/bid/ask `<= 0` is `MARKET_CLOSED` (callbacks `:414-418`, `:521-523`): not triggered;
- `priceTimestamp < createdAt`, `< tpLastUpdated` (TP), `< slLastUpdated` (SL), `< lastUpdated` (entry) returns `BACKDATED_EXECUTION` / `NO_TP` / `NO_SL` (`OstiumTrading.sol:585-619`): skipped until the next second;
- `orderTriggerBlock != 0 && block - triggerBlock < triggerTimeout` returns `PENDING_TRIGGER` (`OstiumTrading.sol:621-623`, `TradingLib.checkNoPendingTrigger`): skipped.

Per position at most one close kind fires, in LIQ > SL > TP order. The callback turns any
close of a liquidatable trade into a liquidation (callbacks `:546`, `:583-584`), so when LIQ
is hit but gated, SL and TP on that trade are held back too. Otherwise they would be a way
round the degraded-mode and recovery-window rules.

`contracts/test/integration/AutomationTriggerRules.t.sol` pins the price choice against the
real contracts. Each case delivers a report in which the mark and the bid/ask sit on opposite
sides of the trigger: TP long on the bid, SL long on the mark, LIMIT buy on the ask, STOP buy
on the mark.

**Where this can still disagree with the contract.** When `priceImpactK > 0` (the redeploy
sets it), the fill price depends on side volume decayed to the callback's `block.timestamp`,
a few blocks after the bot decides. The bot decays to its own clock. Near the boundary the
result can differ by the decay over those seconds. The contract decides again at execution,
so the worst case is a `NOT_HIT` that costs gas and a cooldown, never a wrong execution. The
same holds for fees and price moving between decision and callback (§2.4).

### 11.3 Gates per kind

| Kind | Sequencer STALLED | RECOVERING (1 h window, §3) | Degraded market |
|---|---|---|---|
| LIQ | blocked | blocked | **blocked** (default, §4). `LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED=true` allows it |
| SL, TP | blocked | allowed | allowed: the trader's own close order, and the publisher signs `LIMIT_CLOSE` while degraded |
| LIMIT / STOP | blocked | allowed | **blocked**: the publisher refuses to sign `LIMIT_OPEN` while degraded, so a trigger would only freeze the order until the timeout |

STALLED blocks everything because nothing sent can land. The recovery window exists so a
trader is not liquidated for a move they could not react to. It has no reason to hold back an
order the trader placed themselves.

**Contradiction to decide.** Design spec §2 item 8 says "Degraded mode: opens blocked, closes
**and liquidations flow**". §4 of this document decided the opposite for liquidations, and the
bot follows §4 by default. `LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED` switches to the spec's
behaviour without a code change. Someone has to pick one before acceptance item 8 is run.

### 11.4 Batching, dedupe, cooldown, two instances

- **Batch.** All triggers from one sweep go into as few `performUpkeep` calls as
  `LIQUIDATOR_MAX_BATCH_SIZE` (default 20) allows, with one shared timestamp (the sweep's
  wall-clock second). A non-`SUCCESS` status for one entry does not revert the batch. A
  revert does (for example `WrongParams`, a delisted pair or `done`). After a failed multi-trigger batch, its triggers go out one
  per transaction until each succeeds, so one poisoned trigger cannot block the rest.
- **Dedupe** on `(trader, pair, index, kind)` within a sweep.
- **Cooldown.** Once sent (success or failure) a key is not re-sent for
  `LIQUIDATOR_TRIGGER_COOLDOWN_MS` (default 30 s ≈ `triggerTimeout` 30 blocks). A `NOT_HIT`
  callback clears the on-chain trigger at once, so without the cooldown a position sitting on
  its boundary would be re-triggered every sweep. The cooldown is also the operational
  mitigation for the renewable trigger freeze (L-3, spec §4): the bot only triggers what its
  engine says is hit, and never faster than once per window.
- **Two instances** with two forwarder keys, same DB, no coordination. The loser of a race
  gets `PENDING_TRIGGER` / `NO_TRADE` / `NO_LIMIT`, which are statuses and not reverts
  (`Liquidation.t.sol` `test_twoLiquidatorsOnTheSamePositionDoNotDoubleSettle`). Before
  sending, each instance reads `orderTriggerBlock`, so it usually sees the other instance's
  pending trigger and skips. Per-instance env: `LIQUIDATOR_INSTANCE_NAME`,
  `LIQUIDATOR_FORWARDER_KEY_PATH`, `LIQUIDATOR_METRICS_PORT`, `LIQUIDATOR_DEAD_LETTER_PATH`
  (`services/liquidator/.env.example`).

Run under a supervisor with
`node --env-file=/etc/whitespace/automation-bot-N.env services/liquidator/src/main.mjs`
(or `EnvironmentFile=`). SIGTERM stops scheduling, waits up to 20 s for an in-flight sweep
(which may be mid-send), closes the metrics server and the pool, and exits 0.

### 11.5 Bugs fixed on the way (each with a test that failed first)

| Bug | Fix |
|---|---|
| `setInterval(async …)` let a slow sweep overlap the next one: same candidates, same nonce | `sweepLoop.mjs`: single flight, next sweep scheduled after the previous ends |
| `readMaxLeverage(pairIndex, false)` hardcoded overnight | uses the trade's `isDayTrade` (callbacks `:537` resolves it the same way) |
| `watchLiveness` swallowed RPC errors, so a total outage stayed LIVE forever | a failed poll is "no new block" (`observeFailure`); a startup outage stalls from the first failure, and the first block after it enters RECOVERING |
| `liquidator_oracle_staleness_ms`, `liquidator_rpc_healthy` declared, never set | staleness = age of the last good `/status`; every RPC endpoint probed separately, labelled by scheme+host only (provider URLs carry keys) |
| One reader exception aborted the whole sweep | per-candidate isolation |
| `positionTable.remove` never called | the table is gone; candidates come from the DB every sweep |
| `readTrade` compared viem's `number` leverage to `0n`, so an empty slot was never recognised as closed | every numeric view result is normalised to `bigint` |

### 11.6 Metrics

`liquidator_positions_tracked`, `liquidator_limit_orders_tracked`,
`liquidator_limit_order_table_available`, `liquidator_positions_below_maintenance`,
`liquidator_triggers_{attempted,sent,failed}_total{kind}`, `liquidator_batches_total{ok}`,
`liquidator_lost_race_total{kind}`, `liquidator_suppressed_{degraded,sequencer}_total{kind}`,
`liquidator_candidate_errors_total`, `liquidator_sweep_errors_total{stage}`,
`liquidator_oracle_staleness_ms`, `liquidator_sequencer_state`,
`liquidator_rpc_healthy{endpoint}`, `liquidator_dead_letter_depth`. Served on
`LIQUIDATOR_METRICS_HOST:LIQUIDATOR_METRICS_PORT` (default `127.0.0.1:9464`).

### 11.7 Not done / known limits

- **Not run against a live chain or a live indexer.** Unit tests mock the chain. The SQL runs
  against in-process Postgres (PGlite) with Ponder-shaped tables. `limit_order` is coded
  against the spec §9.1 column contract, which is being built in parallel. The trigger price
  choice is pinned on the real contracts by the forge test above.
- **RPC cost.** Every open position is re-read from chain every sweep: `getOpenTrade`, the
  info and two fee views, plus the per-pair reads that are memoised per sweep. That is fine at
  testnet scale. At larger scale, prefilter on the DB values and re-read only near-trigger
  candidates.
- **Transaction sending** is still the old `txSender.mjs`. It does not advance its cached
  nonce after a mined revert, and it retries a deterministic revert with a gas bump.
  `packages/txsender` (being built in parallel) replaces it behind `sendPerformUpkeep`.
- The degraded-mode liquidation contradiction in §11.3 needs a decision.

## 12. Decision 2026-09-28: liquidate in degraded mode

The user chose to liquidate while a market is degraded (fewer than its minimum healthy
venues). `LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED` now defaults to `true`, superseding §4's
suppression. Reasoning: an under-margined position that is left open while a venue is down
keeps losing the vault's money; the price used is still a k-of-N signed report bounded by the
upkeep's 5% deviation rail. Opens (and LIMIT/STOP entries) stay blocked in degraded mode.
