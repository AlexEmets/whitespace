# Close Without Wallet Balance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make closing a position succeed regardless of the trader's USDW wallet balance, by charging the oracle-fee bond from the position instead of the wallet.

**Architecture:** The bond stops being posted at close-request time and stops being refunded on a successful full close — those two cancel out exactly, so the common path becomes a no-op. The bond is instead charged from the position's collateral on the only two paths where it has teeth: a cancelled close and a partial close. Charging recomputes leverage against a fixed notional, the way `handleRemoveCollateral` already does, and is waived rather than reverted when it cannot be applied safely.

**Tech Stack:** Solidity 0.8.24 (hard pin), Foundry, vendored Ostium contracts under `contracts/src/vendor/ostium/`.

## Global Constraints

- `solc_version = "0.8.24"`, `pragma solidity 0.8.24;` exactly — no caret. (`contracts/foundry.toml:8`)
- `evm_version = "shanghai"` — **no** transient storage (`TSTORE`/`TLOAD`), **no** `MCOPY`. (`contracts/foundry.toml:9`)
- `via_ir = true`, `optimizer_runs = 200` — compiles are slow; expect minutes on the first `forge test` after touching source. (`contracts/foundry.toml:11-12`)
- **Do not move code into or out of a library.** `TradingCallbacksLib` functions are `external` and therefore `DELEGATECALL`ed, so `msg.sender` seen by `OstiumTradingStorage` stays `OstiumTradingCallbacks`. Moving code across that boundary silently breaks the `onlyCallbacks` / `onlyTradingOrCallbacks` checks at `OstiumTradingStorage.sol:116-118` and `:142-147`.
- No storage-layout changes. No new struct fields. This is what keeps the migration to a redeploy-and-repoint rather than a state migration.
- Tests deploy locally via `DeployScript.deployAll`; there are **no** fork tests in this repo and no RPC env var. Follow `contracts/test/helpers/SystemFixture.sol`.
- Test style: `test_lowerCamelCaseSentence()`, every assertion carries a prose failure message, `///` NatSpec citing `file.sol:line` anchors.
- Never link libraries by hand — Foundry auto-deploys and auto-links `TradingLib` and `TradingCallbacksLib` in both `forge test` and `forge script`.
- Build: `pnpm build:contracts` (`cd contracts && forge build --sizes`). Test: `pnpm test:contracts` (`cd contracts && forge test`).
- **Nothing in this plan touches chain 1874.** Deployment and the registry repoint are Task 8, which is a written runbook only and is explicitly not executed.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `contracts/src/vendor/ostium/OstiumTrading.sol` | remove the request-time bond transfer from `closeTradeMarket` | Modify `:309-313` |
| `contracts/src/vendor/ostium/OstiumTradingCallbacks.sol` | remove the full-close refund; charge the bond on cancel and partial | Modify `:336-342`, add a private helper near `:605` |
| `contracts/test/integration/CloseBond.t.sol` | every behaviour this plan changes, plus the parity assertions | Create |
| `docs/superpowers/runbooks/close-bond-migration.md` | deploy + registry repoint procedure, gated on the gov key | Create |

---

## Task 1: Pin down what `closePercentage` actually means

The refund branch keys on `closePercentage == 100e2`, the frontend sends `10000`
(`apps/web/src/hooks/useCloseTrade.ts:9`), but the only existing close test passes `100`
and still asserts a **full** close (`contracts/test/integration/TradeLocal.t.sol:166,174`).
Those three cannot all be right. Every later task branches on this value, so it is settled
first, by a test rather than by reading.

**Files:**
- Read: `contracts/src/vendor/ostium/OstiumTrading.sol` (find `PERCENT_BASE`)
- Test: `contracts/test/integration/CloseBond.t.sol`

**Interfaces:**
- Consumes: nothing.
- Produces: a documented constant `FULL = <value>` used by every later task in this file.

- [ ] **Step 1: Find the declared constant**

Run: `grep -n "PERCENT_BASE" contracts/src/vendor/ostium/OstiumTrading.sol`
Record the literal value in the test's NatSpec.

- [ ] **Step 2: Write a characterisation test for both candidate values**

Create `contracts/test/integration/CloseBond.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemFixture} from "../helpers/SystemFixture.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";

/// @notice The oracle-fee bond on the close path.
/// @dev See docs/superpowers/specs/2026-09-22-close-without-wallet-balance-design.md.
contract CloseBondTest is SystemFixture {
    /// Settled by test_fullCloseIsTenThousandNotOneHundred rather than assumed:
    /// OstiumTrading.PERCENT_BASE, the value that means "close all of it".
    uint16 internal constant FULL = 100e2;

    /// TradeLocal.t.sol:166 passes 100 and asserts a full close at :174. If 100 really is
    /// 1%, that test is asserting the wrong thing and the refund branch at
    /// OstiumTradingCallbacks.sol:336 never fires for it. Settle it.
    function test_fullCloseIsTenThousandNotOneHundred() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        _requestCloseAndFill(100);

        assertGt(
            _openCollateral(),
            0,
            "closePercentage=100 must be a 1% partial close; if this fails, PERCENT_BASE is 100 and every 100e2 in this plan is wrong"
        );
    }
}
```

- [ ] **Step 3: Run it**

Run: `cd contracts && forge test --match-contract CloseBondTest -vv`

Expected: PASS if `PERCENT_BASE == 10000`. If it FAILS, `PERCENT_BASE` is `100`; stop, set `FULL = 100`, and re-check `useCloseTrade.ts:9` — the frontend would then be sending 10000 into a `closePercentage > PERCENT_BASE` revert, which is a separate live bug to report before continuing.

- [ ] **Step 4: Commit**

```bash
git add contracts/test/integration/CloseBond.t.sol
git commit -m "test(contracts): pin down closePercentage semantics on the close path"
```

---

## Task 2: Record today's behaviour as parity baselines

Before changing anything, capture what the current contracts do, so every later task can
assert the new code produces the same money movements. Without this the "economics are
preserved" claim in the spec is an assertion, not a measurement.

**Files:**
- Test: `contracts/test/integration/CloseBond.t.sol`

**Interfaces:**
- Consumes: `FULL` from Task 1.
- Produces: `_bond()`, `_devFees()`, `_openLeverage()` helpers used by Tasks 3–7.

- [ ] **Step 1: Write the helpers and three baseline tests**

Append to `CloseBondTest`:

```solidity
    function _bond() internal view returns (uint256) {
        return IOstiumPairsStorage(d.pairsStorage).pairOracleFee(0);
    }

    function _devFees() internal view returns (uint256) {
        return IOstiumTradingStorage(d.tradingStorage).devFees();
    }

    function _openLeverage() internal view returns (uint32 leverage) {
        (,,,,, leverage,,,,) = IOstiumTradingStorage(d.tradingStorage).openTrades(trader, 0, 0);
    }

    /// Baseline: a full close that executes is bond-neutral — charged at request
    /// (OstiumTrading.sol:311), refunded at execution (OstiumTradingCallbacks.sol:336-342).
    function test_baselineFullCloseIsBondNeutral() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        uint256 devBefore = _devFees();
        _requestCloseAndFill(FULL);

        assertEq(_devFees(), devBefore, "a successful full close must leave devFees unchanged");
        assertEq(_openCollateral(), 0, "a full close must clear the position");
    }

    /// Baseline: a cancelled close keeps the bond. This is the only path where the bond
    /// has teeth, and the behaviour Task 5 must reproduce from collateral instead.
    function test_baselineCancelledCloseKeepsTheBond() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        uint256 devBefore = _devFees();
        _requestCloseAndCancel(FULL);

        assertEq(_devFees(), devBefore + _bond(), "a cancelled close must keep exactly one bond");
        assertGt(_openCollateral(), 0, "a cancelled close must leave the position open");
    }

    /// Baseline: a partial close keeps the bond — there is no refund branch for it.
    function test_baselinePartialCloseKeepsTheBond() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        uint256 devBefore = _devFees();
        _requestCloseAndFill(FULL / 2);

        assertEq(_devFees(), devBefore + _bond(), "a partial close must keep exactly one bond");
    }
```

- [ ] **Step 2: Add every fixture helper this plan uses**

`SystemFixture` exposes none of these yet. Write all of them now, in `CloseBondTest`, so no
later task is blocked on a missing helper. Port the open/close mechanics from
`TradeLocal.t.sol:153-180`, which already does open → `_deliver` → close → `_deliver`.

| Helper | Behaviour |
|---|---|
| `_openAndFill(uint256 collateral)` | `closeTradeMarket`'s counterpart: open a market trade and deliver a valid report so it fills |
| `_requestCloseAndFill(uint16 pct)` | call `closeTradeMarket(0, 0, pct, price, 100)` as `trader`, capture the order id via `_lastPriceRequest()`, deliver a **valid** report |
| `_requestCloseAndCancel(uint16 pct)` | same, but deliver a report with `price = 0`, which sets `CancelReason.MARKET_CLOSED` at `OstiumTradingCallbacks.sol:252` |
| `_drainTraderUsdw()` | `vm.prank(trader)` then transfer the trader's entire USDW balance to a burn address, so `balanceOf(trader) == 0` |
| `_openAtMaxLeverage()` | open a position whose leverage equals `TradingLib.getEffectiveMaxLeverage(0, false, pairsStorage)`, so that subtracting one bond would push it over |
| `_openWithCollateralBelow(uint256 bond)` | open a position, then partially close it until `_openCollateral() <= bond`, since a position cannot be opened below the minimum directly |
| `_expectedFullClosePayout()` | the trade value the position would return, read the same way `TradeLocal.t.sol` measures it — a balance delta around the close, captured in a run with a funded wallet |

Two of these have a trap worth stating. `_openAtMaxLeverage` may be impossible if opening is
itself capped at `maxLeverage` — if so, open just under it and shrink collateral via
`removeCollateral` until the bond would breach the cap. `_expectedFullClosePayout` must not
recompute fees independently; deriving the expected value from the same formulas the
contract uses would assert the code against itself.

- [ ] **Step 3: Run and verify all three PASS against unmodified contracts**

Run: `cd contracts && forge test --match-contract CloseBondTest -vv`
Expected: PASS. These describe the code as it is today. A failure here means the baseline
is misunderstood — stop and re-read, do not adjust the assertion to match.

- [ ] **Step 4: Commit**

```bash
git add contracts/test/integration/CloseBond.t.sol contracts/test/helpers/SystemFixture.sol
git commit -m "test(contracts): baseline the oracle-fee bond across all three close paths"
```

---

## Task 3: Stop posting the bond at close-request time

**Files:**
- Modify: `contracts/src/vendor/ostium/OstiumTrading.sol:309-313`
- Test: `contracts/test/integration/CloseBond.t.sol`

**Interfaces:**
- Consumes: `FULL`, `_bond()`, `_devFees()`.
- Produces: `closeTradeMarket` no longer calls `transferUsdc` or `handleOracleFee`.

- [ ] **Step 1: Write the failing test**

```solidity
    /// The defect this plan exists for. Reproduces reverted tx 0x8a357f2b… on 1874, whose
    /// revert data decoded to ERC20InsufficientBalance(trader, 57243, 1000000).
    function test_traderWithNoUsdwCanStillRequestAClose() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        _drainTraderUsdw();
        assertEq(IERC20(d.collateral).balanceOf(trader), 0, "precondition: the wallet must be empty");

        _requestCloseAndFill(FULL);

        assertEq(_openCollateral(), 0, "a trader holding zero USDW must still be able to close");
    }
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd contracts && forge test --match-test test_traderWithNoUsdwCanStillRequestAClose -vv`
Expected: FAIL with `ERC20InsufficientBalance`.

- [ ] **Step 3: Delete the request-time charge**

In `OstiumTrading.sol`, inside `closeTradeMarket`, delete these four lines:

```solidity
        // Always charge oracle fee for both partial and full closes to prevent griefing
        uint256 oracleFee = pairsStorage.pairOracleFee(pairIndex);
        storageT.transferUsdc(sender, address(storageT), oracleFee);
        storageT.handleOracleFee(oracleFee);
        emit OracleFeeCharged(orderId, sender, pairIndex, oracleFee);
```

Replace with a comment recording why, so a future reader does not restore it:

```solidity
        // The oracle-fee bond is NOT taken here. Upstream pulled it from the trader's
        // wallet at request time to make cancelled closes costly, which meant a trader who
        // spent their balance on margin could not close what they opened — reverted tx
        // 0x8a357f2b… on 1874. It is charged from the position instead, on the two paths
        // where it has teeth: OstiumTradingCallbacks handles cancel and partial close.
        // Request-spam is separately bounded by checkNoPendingTriggers above and by
        // maxPendingMarketOrders in TradingLib.getCloseTradeRevert.
```

- [ ] **Step 4: Run the whole suite**

Run: `cd contracts && forge test -vv`
Expected: the new test PASSES. `test_baselineFullCloseIsBondNeutral` still passes (net zero is now zero-zero rather than minus-plus). `test_baselineCancelledCloseKeepsTheBond` and `test_baselinePartialCloseKeepsTheBond` now **FAIL** — that is correct and Tasks 5 and 6 restore them. Do not delete or weaken them.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/vendor/ostium/OstiumTrading.sol contracts/test/integration/CloseBond.t.sol
git commit -m "fix(contracts): stop charging the close bond to the wallet"
```

---

## Task 4: Remove the now-unmatched full-close refund

With Task 3 landed, the refund at `OstiumTradingCallbacks.sol:336-342` pays out a bond that
was never collected — it would drain `devFees` on every full close and eventually revert in
`refundOracleFee` (`OstiumTradingStorage.sol:465-470`, which reverts `RefundOracleFeeFailed`
when the amount exceeds `devFees`).

**Files:**
- Modify: `contracts/src/vendor/ostium/OstiumTradingCallbacks.sol:336-342`
- Test: `contracts/test/integration/CloseBond.t.sol`

- [ ] **Step 1: Write the failing test**

```solidity
    /// Task 3 stopped collecting the bond, so refunding it would pay out of other traders'
    /// devFees and revert with RefundOracleFeeFailed once devFees runs dry.
    function test_fullCloseDoesNotPayOutABondThatWasNeverCollected() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        uint256 devBefore = _devFees();
        uint256 walletBefore = IERC20(d.collateral).balanceOf(trader);
        _requestCloseAndFill(FULL);

        assertEq(_devFees(), devBefore, "a full close must not move devFees in either direction");
        assertEq(
            IERC20(d.collateral).balanceOf(trader) - walletBefore,
            _expectedFullClosePayout(),
            "the payout must equal the position's trade value, with no bond added on top"
        );
    }
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd contracts && forge test --match-test test_fullCloseDoesNotPayOutABondThatWasNeverCollected -vv`
Expected: FAIL — the payout is one bond too high, or the call reverts `RefundOracleFeeFailed`.

- [ ] **Step 3: Delete the refund branch**

Remove `OstiumTradingCallbacks.sol:336-342` entirely:

```solidity
                    if (closePercentage == 100e2) {
                        // Full close and successfully closed - refund the oracle fee
                        uint256 oracleFee = pairsStorage.pairOracleFee(t.pairIndex);
                        storageT.refundOracleFee(oracleFee);
                        storageT.transferUsdc(address(storageT), t.trader, oracleFee);
                        emit OracleFeeRefunded(i.tradeId, t.trader, t.pairIndex, oracleFee);
                    }
```

Leave `OracleFeeRefunded` declared in the interface — removing an event from an interface is a breaking ABI change for the indexer, and an unused event costs nothing.

- [ ] **Step 4: Run the suite**

Run: `cd contracts && forge test -vv`
Expected: this test and `test_baselineFullCloseIsBondNeutral` PASS. The cancel and partial baselines still fail, pending Tasks 5 and 6.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/vendor/ostium/OstiumTradingCallbacks.sol contracts/test/integration/CloseBond.t.sol
git commit -m "fix(contracts): drop the refund of a bond no longer collected"
```

---

## Task 5: Charge the bond from collateral when a close cancels

This is where the anti-griefing teeth are restored. Collateral falls, so leverage must be
recomputed against a fixed notional — `handleRemoveCollateral` at
`OstiumTradingCallbacks.sol:662-666` is the exact template.

**Files:**
- Modify: `contracts/src/vendor/ostium/OstiumTradingCallbacks.sol` — add a private helper, call it from the cancel path near `:347`
- Test: `contracts/test/integration/CloseBond.t.sol`

**Interfaces:**
- Produces: `function _chargeBondFromPosition(IOstiumTradingStorage.Trade memory t) private returns (bool charged)`

- [ ] **Step 1: Write the failing tests — the charge, and both waive guards**

```solidity
    function test_cancelledCloseChargesTheBondToThePosition() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);
        _drainTraderUsdw();

        uint256 devBefore = _devFees();
        uint256 collateralBefore = _openCollateral();
        _requestCloseAndCancel(FULL);

        assertEq(_devFees(), devBefore + _bond(), "a cancelled close must still cost exactly one bond");
        assertEq(collateralBefore - _openCollateral(), _bond(), "the bond must come out of collateral");
        assertGt(_openCollateral(), 0, "the position must stay open");
    }

    /// Notional is the invariant (OstiumTrading.sol:523-531). Subtracting collateral
    /// without raising leverage would silently delete leverage x bond of exposure.
    function test_chargingTheBondRaisesLeverageAndPreservesNotional() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        uint256 notionalBefore = _openCollateral() * _openLeverage();
        _requestCloseAndCancel(FULL);
        uint256 notionalAfter = _openCollateral() * _openLeverage();

        assertApproxEqRel(notionalAfter, notionalBefore, 1e15, "notional must survive the charge within rounding");
        assertGt(_openLeverage(), 0, "leverage must be rewritten, not left stale");
    }

    /// The guard from the spec: accounting must never block a close.
    function test_bondIsWaivedRatherThanRevertingNearMaxLeverage() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAtMaxLeverage();
        _drainTraderUsdw();

        uint256 devBefore = _devFees();
        _requestCloseAndCancel(FULL);

        assertEq(_devFees(), devBefore, "a bond that cannot be applied safely must be waived");
        assertGt(_openCollateral(), 0, "the position must survive an unchargeable bond");
    }

    function test_bondIsWaivedWhenCollateralIsBelowIt() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openWithCollateralBelow(_bond());
        _drainTraderUsdw();

        uint256 devBefore = _devFees();
        _requestCloseAndCancel(FULL);

        assertEq(_devFees(), devBefore, "a position too small to pay the bond must not be charged");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd contracts && forge test --match-contract CloseBondTest -vv`
Expected: the four above FAIL; `devFees` is unchanged because nothing charges yet.

- [ ] **Step 3: Implement the helper**

Add to `OstiumTradingCallbacks.sol`, beside the existing private `unregisterTrade` at `:605`:

```solidity
    /// @notice Charge one oracle-fee bond to a position's own collateral.
    /// @dev Collateral falls, so leverage is recomputed against a fixed notional exactly as
    ///      handleRemoveCollateral does at :662-666. Returns false — and changes nothing —
    ///      when the charge cannot be applied safely; fee accounting must never be the
    ///      reason a close fails. See the spec's "accounting must never block a close".
    ///      Kept in this contract rather than in TradingCallbacksLib on purpose: storage's
    ///      onlyTradingOrCallbacks check reads msg.sender, and a library DELEGATECALL keeps
    ///      it as this contract only for functions already reached that way.
    function _chargeBondFromPosition(IOstiumTradingStorage.Trade memory t) private returns (bool charged) {
        (IOstiumTradingStorage storageT,, IOstiumPairsStorage pairsStorage) = getContracts();
        uint256 bond = pairsStorage.pairOracleFee(t.pairIndex);

        if (t.collateral <= bond) return false;

        uint256 tradeSize = t.collateral.mulDiv(t.leverage, 100, Math.Rounding.Ceil);
        uint256 newCollateral = t.collateral - bond;
        uint32 newLeverage = (tradeSize * PRECISION_6 / newCollateral / 1e4).toUint32();

        // `TradingLib` may not be imported in this contract — the close callback obtains
        // maxLeverage inline around :267-276. Reuse whichever route already compiles here
        // rather than adding an import, which would change the contract's link footprint.
        uint32 maxLeverage = TradingLib.getEffectiveMaxLeverage(t.pairIndex, t.isDayTrade, pairsStorage);
        if (newLeverage > maxLeverage) return false;

        t.collateral = newCollateral;
        t.leverage = newLeverage;
        storageT.updateTrade(t);

        storageT.handleOracleFee(bond);
        emit OracleFeeCharged(0, t.trader, t.pairIndex, bond);
        return true;
    }
```

- [ ] **Step 4: Call it on the cancel path**

At `OstiumTradingCallbacks.sol:347`, extend the existing cancel emit:

```solidity
        if (cancelReason != CancelReason.NONE) {
            // NO_TRADE and WRONG_TRADE mean there is no position to charge — the first has
            // no open trade at all, the second refers to a trade that was already replaced.
            if (cancelReason != CancelReason.NO_TRADE && cancelReason != CancelReason.WRONG_TRADE) {
                _chargeBondFromPosition(storageT.getOpenTrade(trade.trader, trade.pairIndex, trade.index));
            }
            emit MarketCloseCanceled(a.orderId, i.tradeId, trade.trader, trade.pairIndex, trade.index, cancelReason);
        }
```

- [ ] **Step 5: Run the suite**

Run: `cd contracts && forge test -vv`
Expected: all four new tests PASS, and `test_baselineCancelledCloseKeepsTheBond` PASSES again — the same `devFees` delta, now sourced from collateral.

- [ ] **Step 6: Commit**

```bash
git add contracts/src/vendor/ostium/OstiumTradingCallbacks.sol contracts/test/integration/CloseBond.t.sol
git commit -m "fix(contracts): charge the close bond to the position on cancel"
```

---

## Task 6: Charge the bond on a partial close

`unregisterTrade` (`OstiumTradingStorage.sol:220-226`) scales `collateral` and `oiNotional`
together on a partial close, so leverage is preserved by construction and the bond charge is
a *separate* reduction that does move leverage. Charge after the unregister, so the helper
sees the post-partial position.

**Files:**
- Modify: `contracts/src/vendor/ostium/OstiumTradingCallbacks.sol` — success branch, after `:334`
- Test: `contracts/test/integration/CloseBond.t.sol`

- [ ] **Step 1: Write the failing test**

```solidity
    function test_partialCloseChargesTheBondToTheRemainder() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);
        _drainTraderUsdw();

        uint256 devBefore = _devFees();
        _requestCloseAndFill(FULL / 2);

        assertEq(_devFees(), devBefore + _bond(), "a partial close must cost exactly one bond");
        assertGt(_openCollateral(), 0, "a partial close must leave a position behind");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd contracts && forge test --match-test test_partialCloseChargesTheBondToTheRemainder -vv`
Expected: FAIL — `devFees` unchanged.

- [ ] **Step 3: Charge in the success branch, partial only**

Immediately after the `emit MarketCloseExecutedV2(...)` block that ends at `:334`, where the
deleted refund branch used to sit:

```solidity
                    if (closePercentage != 100e2) {
                        // A partial close leaves a position behind, so the bond has something
                        // to come out of. A full close leaves nothing and costs nothing — the
                        // request-time charge and the refund used to cancel out, and now
                        // neither happens.
                        _chargeBondFromPosition(storageT.getOpenTrade(t.trader, t.pairIndex, t.index));
                    }
```

- [ ] **Step 4: Run the whole suite**

Run: `cd contracts && forge test -vv`
Expected: everything green, including both remaining baselines from Task 2.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/vendor/ostium/OstiumTradingCallbacks.sol contracts/test/integration/CloseBond.t.sol
git commit -m "fix(contracts): charge the close bond to the remainder on a partial close"
```

---

## Task 7: Prove the whole system still balances

Per-path assertions can each pass while the contract leaks value overall. This task checks
the invariant that matters: USDW in equals USDW out.

**Files:**
- Test: `contracts/test/integration/CloseBond.t.sol`

- [ ] **Step 1: Write the conservation test**

```solidity
    /// Every path, one after another, against a single funded trader. The storage contract
    /// must hold exactly the collateral still at risk plus the fees it has accrued — no
    /// more (value invented) and no less (value leaked).
    function test_usdwIsConservedAcrossEveryClosePath() public {
        _configureAll();
        _fundTrader(10_000e6);

        uint256 totalBefore = IERC20(d.collateral).balanceOf(trader)
            + IERC20(d.collateral).balanceOf(d.tradingStorage);

        _openAndFill(1000e6);
        _requestCloseAndCancel(FULL);
        _requestCloseAndFill(FULL / 2);
        _requestCloseAndFill(FULL);

        uint256 totalAfter = IERC20(d.collateral).balanceOf(trader)
            + IERC20(d.collateral).balanceOf(d.tradingStorage);

        assertEq(totalAfter, totalBefore, "USDW must be conserved between the trader and storage");
    }

    /// The trader must end with no position and a non-zero wallet, from a standing start of
    /// zero wallet balance — the end-to-end statement of what this plan is for.
    function test_aDrainedTraderEndsWithTheirMoneyBack() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);
        _drainTraderUsdw();

        _requestCloseAndFill(FULL);

        assertEq(_openCollateral(), 0, "the position must be closed");
        assertGt(IERC20(d.collateral).balanceOf(trader), 0, "the trader must be paid out");
    }
```

- [ ] **Step 2: Run**

Run: `cd contracts && forge test --match-contract CloseBondTest -vv`
Expected: PASS. If conservation fails, a bond is being counted twice or dropped — do not adjust the tolerance, find it.

- [ ] **Step 3: Full gate**

Run: `cd contracts && forge test` then `cd contracts && forge build --sizes`
Expected: all suites green. Check `--sizes` output: `OstiumTradingCallbacks` gained a function; confirm it is still under the 24576-byte limit.

- [ ] **Step 4: Commit**

```bash
git add contracts/test/integration/CloseBond.t.sol
git commit -m "test(contracts): assert USDW conservation across every close path"
```

---

## Task 8: Write the migration runbook — do NOT execute it

**Files:**
- Create: `docs/superpowers/runbooks/close-bond-migration.md`

- [ ] **Step 1: Write the runbook**

It must state, with the reasoning already established in the spec:

- Neither `trading` (`0x9f7F9be7731E805B0b9174465257f0C1Ab589f27`) nor `callbacks` (`0x4084cd63dB84c88c98418e33b88449b3b006da9c`) is upgradeable. Both are bare `ERC1967Proxy` — 77-byte runtime, admin slot `0x0`, and no `upgradeTo` anywhere in the implementation. **Both must be redeployed.**
- `TradingStorage` is not redeployed, so open positions, balances and `devFees` survive.
- The switch is `OstiumRegistry.updateContract(bytes32,address)`, `onlyGov`. Gov is `0xFB042739DaA0946E9e6658CA6603Ff5EcEa60Dd8`, an **EOA** (code `0x`, nonce 24), whose key is **not in this repository**. Finding it is a precondition, not a step.
- Ordering: deploy both, then repoint `'callbacks'` and `'trading'` in a single sequence. Between the two updates the system is mismatched — an old Trading charging a bond that a new Callbacks will not refund. Drain pending orders first and pause if the contracts support it.
- Rollback: `updateContract` back to the two addresses above. Include them verbatim.
- In-flight pending close orders at the moment of the switch will cancel. Say so plainly.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/close-bond-migration.md
git commit -m "docs: runbook for the close-bond contract migration"
```

- [ ] **Step 3: Stop**

Do not deploy. Do not call `updateContract`. Report completion and hand the go/no-go to the user, who must first confirm control of the gov key.

---

## Out of scope

- The frontend's wallet-balance coupling on the close path, and the `describeTxError`
  sentence that names closing. Separate plan; it is safe to ship before or after this one.
- `removeCollateral` and `topUpCollateral` keep charging the bond to the wallet. They are
  optional actions a trader can decline, not a trapdoor.
- Reserving a bond at open time. The trap is gone once this ships, so there is nothing left
  to reserve against.
