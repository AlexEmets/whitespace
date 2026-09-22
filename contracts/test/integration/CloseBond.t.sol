// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SystemFixture} from "../helpers/SystemFixture.sol";
import {ReportLib} from "../helpers/ReportLib.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumTradingCallbacks} from "../../src/vendor/ostium/interfaces/IOstiumTradingCallbacks.sol";
import {IOstiumPairsStorage} from "../../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {TradingLib} from "../../src/vendor/ostium/lib/TradingLib.sol";

/// @notice The oracle-fee bond on the close path.
/// @dev See docs/superpowers/specs/2026-09-22-close-without-wallet-balance-design.md.
contract CloseBondTest is SystemFixture {
    /// Settled by test_fullCloseIsTenThousandNotOneHundred rather than assumed:
    /// OstiumTrading.PERCENT_BASE (OstiumTrading.sol:28), the value that means "close all of it".
    uint16 internal constant FULL = 100e2;

    address internal trader = address(0x7AA);

    // -------------------------------------------------------------------------------------
    // Fixture wiring — single-trader wrappers around SystemFixture's multi-trader API.
    // Later tasks in this plan append more helpers here; keep additions in this shape.
    // -------------------------------------------------------------------------------------

    /// @dev Names `SystemFixture._deployConfiguredSystem` (SystemFixture.sol:66) the way
    ///      `TradeLocal.t.sol:58` does, since every test below calls it by that name.
    function _configureAll() internal {
        _deployConfiguredSystem();
    }

    /// @dev Overloads (does not override) `SystemFixture._fundTrader(address,uint256)`
    ///      (SystemFixture.sol:171) for this suite's single implicit `trader`.
    function _fundTrader(uint256 amount) internal {
        _fundTrader(trader, amount);
    }

    /// @dev Overloads `SystemFixture._collateralOf` (SystemFixture.sol:226) for `trader`'s
    ///      first (and only, in this plan) open-trade slot.
    function _openCollateral() internal view returns (uint256 collateral) {
        return _collateralOf(trader, 0);
    }

    /// @dev `closeTradeMarket`'s counterpart: open a market trade and deliver a valid report
    ///      so it fills. Delegates to `SystemFixture._openPositionAtBaseline`
    ///      (SystemFixture.sol:232-235), which does exactly this for a given `who`.
    function _openAndFill(uint256 collateral) internal {
        _openPositionAtBaseline(trader, collateral);
    }

    /// @dev Request a close at `pct` (the `closePercentage` argument, precision-2 — see `FULL`
    ///      above) and deliver a valid report so it fills. Ported from `TradeLocal.t.sol:164-172`.
    function _requestCloseAndFill(uint16 pct) internal {
        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarket(
            0, 0, pct, uint192(uint256(int256(BTC_65K))), 100
        );
        (uint256 orderId, uint32 timestamp) = _lastPriceRequest();
        _deliver(orderId, _signed(timestamp, BTC_65K));
    }

    /// @dev Same wire fields `_signed` builds, but with `isMarketOpen: false`. Signing
    ///      `price: 0` directly with `isMarketOpen: true` reverts `NonPositivePrice`
    ///      (`WhitespacePriceUpKeep.sol`'s `_checkPrice`) before the price ever reaches a
    ///      callback — the zero price the callbacks treat as "market closed" only exists
    ///      because `performUpkeep`'s `isMarketOpen == false` branch unconditionally zeroes
    ///      `a.price`/`a.bid`/`a.ask` (and skips the deviation rail) regardless of what was
    ///      signed. This is how a "price = 0" report is actually produced.
    function _marketClosedReport(uint32 timestamp) internal view returns (bytes memory) {
        ReportLib.Report memory r = ReportLib.btcReport(address(verifier), FEED, timestamp, BTC_65K);
        r.isMarketOpen = false;
        return ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3));
    }

    /// @dev Request a close at `pct` and deliver a market-closed report, which
    ///      `OstiumTradingCallbacks.sol:250-252` turns into `CancelReason.MARKET_CLOSED`.
    ///      Decodes the emitted `MarketCloseCanceled` event rather than assuming the delivery
    ///      took that branch — a different cancel reason (e.g. `WRONG_TRADE`) would also leave
    ///      the position open and keep the bond, but for a reason this plan is not describing.
    function _requestCloseAndCancel(uint16 pct) internal {
        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarket(
            0, 0, pct, uint192(uint256(int256(BTC_65K))), 100
        );
        (uint256 orderId, uint32 timestamp) = _lastPriceRequest();
        _deliver(orderId, _marketClosedReport(timestamp));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("MarketCloseCanceled(uint256,uint256,address,uint256,uint256,uint8)");
        for (uint256 j = logs.length; j > 0; j--) {
            if (logs[j - 1].topics.length > 0 && logs[j - 1].topics[0] == sig) {
                (,, IOstiumTradingCallbacks.CancelReason reason) =
                    abi.decode(logs[j - 1].data, (uint256, uint256, IOstiumTradingCallbacks.CancelReason));
                assertEq(
                    uint8(reason),
                    uint8(IOstiumTradingCallbacks.CancelReason.MARKET_CLOSED),
                    "a price=0 report must cancel with MARKET_CLOSED, not some other reason"
                );
                return;
            }
        }
        revert("no MarketCloseCanceled emitted for _requestCloseAndCancel");
    }

    /// @dev Burns the trader's entire USDW balance so `balanceOf(trader) == 0` — the
    ///      precondition the rest of this plan closes a position without.
    /// @dev The balance must be read BEFORE `vm.prank`: `vm.prank` applies to only the single
    ///      next external call, and `balanceOf` evaluated inline as a `transfer` argument is
    ///      itself that next call, silently consuming the prank and leaving `transfer` to run
    ///      as this test contract (whose own USDW balance is zero).
    function _drainTraderUsdw() internal {
        uint256 balance = IERC20(d.collateral).balanceOf(trader);
        vm.prank(trader);
        IERC20(d.collateral).transfer(address(0xdead), balance);
    }

    /// @dev Opens directly at `TradingLib.getEffectiveMaxLeverage` rather than working up to it
    ///      via `removeCollateral`: `OstiumTrading.sol`'s open-time check is `t.leverage >
    ///      maxLeverage`, so leverage exactly equal to the cap is accepted on open, not just
    ///      reachable afterward. $1,000 collateral at this pair's 100.00x cap sits comfortably
    ///      inside `pairMinLevPos`, `maxOpenInterest` and `groupMaxCollateral` (20% of a
    ///      100,000e6 vault) — see `Operate.s.sol`'s `PAIR_MAX_LEVERAGE`/`PAIR_MAX_OI`/
    ///      `GROUP_MAX_COLLATERAL_P` constants.
    function _openAtMaxLeverage() internal {
        uint32 maxLeverage = TradingLib.getEffectiveMaxLeverage(0, false, IOstiumPairsStorage(d.pairsStorage));
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(trader, 1000e6, maxLeverage, true);
        _deliver(orderId, _signed(timestamp, BTC_65K));
    }

    /// @dev A position cannot be opened directly with collateral at or below the bond, and
    ///      reaching it via a partial close needs more care than the obvious percentage math:
    ///      at this pair's 10x baseline leverage, `pairMinLevPos`'s $10 floor caps how low a
    ///      partial close can push collateral at exactly $1 — the same value as the bond
    ///      (`FEE_MIN_LEV_POS` / 10x == `FEE_ORACLE_FEE`, both `Operate.s.sol` constants) — so
    ///      there is zero rounding slack for `closePercentage`'s 0.01% granularity to land at or
    ///      under it without instead landing just under the floor and reverting
    ///      `BelowMinLevPos` (confirmed by running this at 10x: collateral net of the opening
    ///      fee is 999e6, not the nominal 1000e6, and the resulting `closePercentage` overshoots
    ///      the floor by exactly 1e3). Opening at max leverage instead (`_openAtMaxLeverage`)
    ///      drops that floor to $0.10, which is comfortable headroom, then a ceiling-rounded
    ///      `closePercentage` (so the amount removed is never less than `collateral - bond`)
    ///      partially closes down to at or under the bond without touching the floor.
    function _openWithCollateralBelow(uint256 bond) internal {
        _openAtMaxLeverage();
        uint256 collateral = _openCollateral();
        uint256 toRemove = collateral - bond;
        uint16 pct = uint16((toRemove * FULL + collateral - 1) / collateral); // ceil division
        assertLt(pct, FULL, "_openWithCollateralBelow must not compute a full close");
        _requestCloseAndFill(pct);
        assertLe(
            _openCollateral(), bond, "_openWithCollateralBelow must leave collateral at or under the bond"
        );
        assertGt(_openCollateral(), 0, "_openWithCollateralBelow must not fully close the position");
    }

    /// @dev What a full close pays out, measured rather than recomputed: snapshot state,
    ///      actually run the full close against `trader`'s live, funded position, read the
    ///      USDW balance delta, then roll back so the caller's position and wallet are
    ///      untouched. Recomputing this from `OstiumPairInfos`' own fee/PnL formulas would
    ///      assert the contract against itself; asking the contract directly (while the wallet
    ///      is still funded enough to pay the bond) and then undoing it is the only way later
    ///      tasks get an independent number to compare their own payout against.
    function _expectedFullClosePayout() internal returns (uint256 payout) {
        uint256 snapshotId = vm.snapshotState();
        uint256 before = IERC20(d.collateral).balanceOf(trader);
        _requestCloseAndFill(FULL);
        payout = IERC20(d.collateral).balanceOf(trader) - before;
        vm.revertToState(snapshotId);
    }

    /// @dev The oracle-fee bond charged and refunded on the close path
    ///      (`OstiumTrading.sol:311`, `OstiumTradingCallbacks.sol:336-342`).
    function _bond() internal view returns (uint256) {
        return IOstiumPairsStorage(d.pairsStorage).pairOracleFee(0);
    }

    /// @dev Accrued protocol fees, including any bond kept on a cancelled or partial close.
    function _devFees() internal view returns (uint256) {
        return IOstiumTradingStorage(d.tradingStorage).devFees();
    }

    /// @dev `trader`'s leverage on their one open-trade slot, PRECISION_2. `openTrades` returns
    ///      the 10-tuple `(collateral, openPrice, tp, sl, trader, leverage, pairIndex, index,
    ///      buy, isDayTrade)` — leverage is the 6th field.
    function _openLeverage() internal view returns (uint32 leverage) {
        (,,,,, leverage,,,,) = IOstiumTradingStorage(d.tradingStorage).openTrades(trader, 0, 0);
    }

    // -------------------------------------------------------------------------------------
    // Characterisation
    // -------------------------------------------------------------------------------------

    /// TradeLocal.t.sol:166 passes closePercentage = 0 (its literal 100 there is the
    /// unrelated slippageP argument), which OstiumTrading.sol:297-299 defaults to
    /// PERCENT_BASE — so that test exercises a full close without ever pinning what
    /// PERCENT_BASE actually is. Seven later tasks in this plan branch on that value, so it
    /// is settled here by test rather than by reading.
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
}
