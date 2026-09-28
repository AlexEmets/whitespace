# Testnet-perfect — contract test suites

Branch `test/testnet-perfect-contract-tests` (off `feat/testnet-perfect`). Spec:
`docs/superpowers/specs/2026-09-28-testnet-perfect-design.md` §7. Only `contracts/test/` and a
profile in `contracts/foundry.toml` were changed; `contracts/src` and `contracts/script` are
untouched.

## What is covered

Every suite runs on `TestnetFixture` — the system exactly as `DeployTestnet.s.sol` builds it —
through the production path: a trader or forwarder request, then a 3-of-5 signed report
delivered by the keeper through the hardened upkeep. Shared helpers:
`contracts/test/helpers/TestnetTrading.sol`.

| Suite | File | Tests |
|---|---|---|
| Trading | `test/unit/Trading.t.sol` | 62 |
| Vault | `test/unit/Vault.t.sol` | 19 |
| PairInfos economics | `test/unit/PairInfosEconomics.t.sol` | 18 (4 fuzz) |
| TradesUpKeep | `test/unit/TradesUpKeep.t.sol` | 17 |
| Findings (regressions) | `test/unit/Findings.t.sol` | 1 |
| Protocol invariants | `test/invariant/Protocol.t.sol` | 5 invariants + 1 reachability test |

- **Trading:** market open success with every USDW accounted for; every request revert;
  every cancel reason the testnet config reaches — SLIPPAGE (both sides, inclusive boundary),
  TP/SL_REACHED, EXPOSURE_LIMITS (OI cap and shared group collateral), PRICE_IMPACT (reached at
  the deployed parameters by same-block round trips), MAX_LEVERAGE, PAUSED, MARKET_CLOSED;
  open/close timeouts incl. retry; partial/full close with the bond; LIMIT/STOP place, update,
  cancel, trigger (hit, NOT_HIT at one wei/one tick, TP/SL reached, exposure, paused, closed);
  TP/SL automation hit/not hit; `updateTp`/`updateSl` bounds on both sides; top-up (exact and
  rounded) and remove-collateral (executed, rounded, rejected UNDER_LIQUIDATION / MARKET_CLOSED /
  PAUSED / MAX_LEVERAGE, request reverts); pause/done; max trades per pair; market isolation.
- **Vault:** request/settle (forced, interval, and by an overdue trade close)/claim, cancel,
  reclaim both directions, withdraw delay, pro-rata oversubscription, share price vs trader PnL,
  unrealised PnL at settlement, MM deposit/withdraw bounded by buffer, daily PnL cap.
- **PairInfos:** maker/taker/mixed opening fees and the 50/50 split; funding matched exactly
  against a transcription of the contract formula for any horizon, direction, per-block cap,
  convergence; rollover per block and per trade; a close charging exactly the accrued fees; the
  liquidation boundary (liquidates at the boundary, NOT_HIT one wei better, matches
  `getTradeLiquidationPrice` to 1e-6); dynamic-spread fills for several sizes on BTC and WBT;
  volume decay.
- **TradesUpKeep:** allowlist roles; every returned `AutomationOrderStatus`; mixed batches; the
  entries that revert a whole batch.
- **Invariants:** (a) USDW conservation; (b) storage balance == open + pending + resting
  collateral + devFees (exact); (c) no successful open leaves OI above its cap; (d) every
  position below maintenance at the last accepted price is liquidated by trigger + delivery;
  (e) vault USDW == `(maxAccPnlPerToken − accPnlPerToken)·supply` + settled open PnL + LP
  requests in flight, within rounding dust. Default 20 runs × 100 depth;
  `FOUNDRY_PROFILE=invariant` runs 256 × 200 (51,200 calls per invariant, passing, ~4 min)
  and 1,024 fuzz runs.

Not reachable on this deployment, so not tested: `AutomationOrderStatus.IN_TIMEOUT` (never
returned by the code); `DAY_TRADE_NOT_ALLOWED` (no pair has an overnight leverage, so no trade
is a day trade); WRONG_TRADE on a limit open (the order cannot be replaced within `maxAge`).

## Coverage (`forge coverage --ir-minimum`, lines / branches)

"Before" is the pre-existing suite on the same commit; "after" includes the new suites.

| Contract | Before | After |
|---|---|---|
| OstiumTrading | 57.6% / 15.5% | 93.5% / 85.9% |
| OstiumTradingCallbacks | 59.4% / 28.8% | 86.4% / 48.5% |
| TradingCallbacksLib | 74.0% / 39.6% | 91.8% / 72.9% |
| TradingLib | 57.1% / 10.0% | 92.9% / 85.0% |
| OstiumTradingStorage | 63.5% / 43.8% | 83.1% / 46.9% |
| OstiumVault | 44.7% / 9.4% | 77.3% / 60.9% |
| OstiumPairInfos | 49.4% / 11.9% | 59.9% / 33.9% |
| OstiumPairsStorage | 40.2% / 12.5% | 45.6% / 12.5% |
| OstiumTradesUpKeep | 54.1% / 42.9% | 94.6% / 85.7% |
| OstiumOpenPnl | 83.6% / 33.3% | 83.6% / 33.3% |
| WhitespacePriceUpKeep | 80.3% / 63.6% | 82.7% / 81.8% |
| **Total (all files)** | 59.3% / 26.4% | 75.6% / 51.9% |

The remaining PairInfos/PairsStorage gaps are mostly gov setters and migration
initialisers; OpenPnl's are the `CurrentNotionalUnderflow` guards.

## Findings

### FIXED — a short open could leave OI above `maxOi` (`test_aShortOpenCannotLeaveOiAboveTheCap`)

**Status: fixed** in `lib/TradingCallbacksLib.sol` (`withinExposureLimits` now takes the fill price and charges a short at `notional * price / fillPrice`); the test was inverted into a regression that failed before the fix. Original analysis below.

`TradingCallbacksLib.withinExposureLimits` admits a trade if
`OI_side × price + collateral × leverage ≤ maxOi`, i.e. it charges the **pre-fee** notional.
The OI actually stored is `postFeeCollateral × leverage / fillPrice` units. A short fills
**below** the oracle price by its price impact, so those units are worth
`postFeeNotional × price / fillPrice ≈ postFee / (1 − impact)` at the oracle price. Whenever
impact exceeds the levered fee fraction, a short admitted exactly at the cap leaves the short
side above it. Longs are unaffected (their fill is above the price).

Reproduction on WBT (cap 100,000; K = 1e19): five same-block 100k long round trips leave
492,375 of sell-side volume; a 20,000 USDW 5x short (100,000 pre-fee — exactly the cap) fills
at 19.8916 against a 20.00 oracle (−0.54%) with 19,939 of post-fee collateral, and the short
side's OI is then worth **100,238.52 USDW at the oracle price — 0.24% over the cap**.
Severity: low (bounded by impact − fee, and closing trades still work), but it is the one
case where invariant (c) is not guaranteed by construction. The fuzzer did not hit it in 51k
calls because it needs heavy one-sided volume and an at-cap short. Fix direction (not applied):
check the cap against the post-fee notional valued at the fill price. The test asserts the
faulty outcome, so it flips red when `src` is fixed and should then be inverted.

### Design notes (characterised, not bugs)

- All four markets share one collateral group: collateral on BTC consumes the per-side capacity
  of ETH/SOL/WBT (`test_isolation_groupCollateralIsSharedAcrossMarkets`).
- A winning close paying out more than 10% of the vault in a day (`maxDailyAccPnlDeltaPerToken`)
  reverts the keeper's delivery; the trader's only exit is the close timeout
  (`test_dailyPnlCap_revertsAnOversizedWinningClose`).
- From a neutral vault, trader losses do not raise the LP share price; they accrue as buffer
  (`test_traderLossFromNeutral_becomesBufferNotSharePrice`).
- One malformed automation entry (REMOVE_COLLATERAL / PENDING_CLOSE / unlisted pair) reverts
  the whole forwarder batch (`test_batch_aSingleInvalidEntryRevertsTheWholeBatch`).
- `closeTradeMarket` on an empty slot reports `NoTradeFound(trader, 0, 0)` regardless of the
  requested pair/index.

### Test-infrastructure note

Under via-IR the optimiser can reuse a `block.timestamp`/`block.number` read from before a
`vm.warp`/`vm.roll` inside one inlined test function, silently backdating requests. The new
suites read time through `vm.getBlockTimestamp()`/`vm.getBlockNumber()`; the fixture's
`_trigger` has a timestamp-safe twin `_triggerNow`.
