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
import {IOstiumPairInfos} from "../../src/vendor/ostium/interfaces/IOstiumPairInfos.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {TradingLib} from "../../src/vendor/ostium/lib/TradingLib.sol";
import {TradingCallbacksLib} from "../../src/vendor/ostium/lib/TradingCallbacksLib.sol";

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
        _requestCloseAndFillAt(pct, BTC_65K);
    }

    /// @dev `_requestCloseAndFill` at an arbitrary report price. `wantedPrice` tracks the report
    ///      rather than staying pinned at $65,000 on purpose: `closeTradeMarketCallback` measures
    ///      slippage as `wantedPrice * slippageP / 100 / 100` — 1% at `slippageP = 100` — so a
    ///      close delivered more than 1% away from the requested price cancels with `SLIPPAGE`
    ///      instead of filling, which is a different branch from the one the caller is testing.
    function _requestCloseAndFillAt(uint16 pct, int192 price) internal {
        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarket(
            0, 0, pct, uint192(uint256(int256(price))), 100
        );
        (uint256 orderId, uint32 timestamp) = _lastPriceRequest();
        _deliver(orderId, _signed(timestamp, price));
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
    /// @dev The pair's effective cap for an overnight trade, which is what every leverage check on
    ///      the close path compares against.
    function _maxLeverage() internal view returns (uint32) {
        return TradingLib.getEffectiveMaxLeverage(0, false, IOstiumPairsStorage(d.pairsStorage));
    }

    function _openAtLeverage(uint32 leverage, uint256 collateral) internal {
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(trader, collateral, leverage, true);
        _deliver(orderId, _signed(timestamp, BTC_65K));
    }

    /// @dev Opens directly at `TradingLib.getEffectiveMaxLeverage` rather than working up to it
    ///      via `removeCollateral`: `OstiumTrading.sol`'s open-time check is `t.leverage >
    ///      maxLeverage`, so leverage exactly equal to the cap is accepted on open, not just
    ///      reachable afterward. $1,000 collateral at this pair's 100.00x cap sits comfortably
    ///      inside `pairMinLevPos`, `maxOpenInterest` and `groupMaxCollateral` (20% of a
    ///      100,000e6 vault) — see `Operate.s.sol`'s `PAIR_MAX_LEVERAGE`/`PAIR_MAX_OI`/
    ///      `GROUP_MAX_COLLATERAL_P` constants.
    function _openAtMaxLeverage() internal {
        _openAtLeverage(_maxLeverage(), 1000e6);
    }

    /// @dev A position cannot be opened directly with collateral at or below the bond, so this
    ///      state is reached by partially closing down to it. The leverage matters twice and in
    ///      opposite directions:
    ///
    ///      - `pairMinLevPos`'s $10 notional floor becomes a collateral floor of
    ///        `$10 * 100 / leverage`. At the 10x baseline that floor is exactly $1 — the same
    ///        value as the bond (`FEE_MIN_LEV_POS` / 10x == `FEE_ORACLE_FEE`, both
    ///        `Operate.s.sol` constants) — leaving zero slack for `closePercentage`'s 0.01%
    ///        granularity to land at or under the bond rather than just under the floor, which
    ///        reverts `BelowMinLevPos`. So this cannot be built at 10x.
    ///      - Half the cap puts that floor at $0.20, comfortable slack, while keeping leverage
    ///        far enough under `maxLeverage` that the post-charge leverage recompute is provably
    ///        not what rejects the bond. That isolation is the point: this helper's caller names
    ///        the below-the-bond guard, so no other guard may be reachable in the state it builds.
    ///
    ///      A ceiling-rounded `closePercentage` makes the amount removed never less than
    ///      `collateral - bond`, so the remainder lands at or under the bond, never above it.
    function _openWithCollateralBelow(uint256 bond) internal {
        _openAtLeverage(_maxLeverage() / 2, 1000e6);
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

    /// @dev The 2nd and 3rd fields of the same 10-tuple.
    function _openPrice() internal view returns (uint192 openPrice) {
        (, openPrice,,,,,,,,) = IOstiumTradingStorage(d.tradingStorage).openTrades(trader, 0, 0);
    }

    /// @dev The 4th field of the same 10-tuple.
    function _openSl() internal view returns (uint192 sl) {
        (,,, sl,,,,,,) = IOstiumTradingStorage(d.tradingStorage).openTrades(trader, 0, 0);
    }

    function _openTp() internal view returns (uint192 tp) {
        (,, tp,,,,,,,) = IOstiumTradingStorage(d.tradingStorage).openTrades(trader, 0, 0);
    }

    function _tradeInfo() internal view returns (IOstiumTradingStorage.TradeInfo memory) {
        return IOstiumTradingStorage(d.tradingStorage).getOpenTradeInfo(trader, 0, 0);
    }

    /// @dev The long side of the pair's group collateral. `_chargeBondFromPosition` must debit
    ///      this in lockstep with the trade's own collateral field, the way
    ///      `handleRemoveCollateral` does — they track the same money.
    function _groupCollateral() internal view returns (uint256) {
        return IOstiumPairsStorage(d.pairsStorage).groupCollateral(0, true);
    }

    /// @dev How far the open position is above its liquidation margin, valued at `price`.
    ///
    ///      This is what the bond eats: the leverage recompute holds `collateral x leverage`
    ///      fixed, and `liqMarginValue` is a pure function of that product
    ///      (`OstiumPairInfos.getTradeLiquidationMargin`), so charging one bond drops `tradeValue`
    ///      by exactly one bond and leaves `liqMarginValue` where it was.
    ///
    ///      Rollover and funding are passed as zero rather than read: `Deploy.s.sol` sets
    ///      `OPEN_ROLLOVER_FEE = 0` and `Operate.s.sol` sets `maxFundingFeePerBlock: 0`, so both
    ///      accumulators are pinned at zero for this fixture's whole life. Anything non-zero here
    ///      would mean the fixture changed underneath this helper.
    function _headroomAt(uint256 collateral, uint32 leverage, int192 price) internal view returns (int256) {
        IOstiumPairInfos pairInfos = IOstiumPairInfos(d.pairInfos);
        (int256 profitP,) = TradingCallbacksLib.currentPercentProfit(
            int256(uint256(_openPrice())),
            int256(price),
            true,
            int32(leverage),
            int32(_tradeInfo().initialLeverage)
        );
        return int256(pairInfos.getTradeValuePure(collateral, profitP, 0, 0))
            - int256(pairInfos.getTradeLiquidationMargin(collateral, leverage, _maxLeverage()));
    }

    /// @dev The *mid* price to sign so that a long position of `collateral` at `leverage` is left
    ///      exactly `headroom` above its liquidation margin when the close executes.
    ///
    ///      Inverts `_headroomAt`. `headroom = collateral x (1e8 + profitP - rawAdjustedThreshold)
    ///      / 1e8`, so the profit percentage that produces a wanted headroom is
    ///      `profitP = headroom x 1e8 / collateral + rawAdjustedThreshold - 1e8`, and
    ///      `currentPercentProfit` inverts to `price = openPrice + profitP x openPrice /
    ///      (1e6 x leverage)`. The `+ 1e18` at the end converts the execution price back to a mid:
    ///      a long closes against the bid, and `ReportLib.btcReport` quotes `bid = price - 1e18`.
    function _midPriceLeavingHeadroom(uint256 collateral, uint32 leverage, uint256 headroom)
        internal
        view
        returns (int192)
    {
        uint256 rawAdjustedThreshold =
            uint256(IOstiumPairInfos(d.pairInfos).liqMarginThresholdP()) * leverage * 1e6 / _maxLeverage();

        int256 openPrice = int256(uint256(_openPrice()));
        int256 profitP =
            int256(headroom * 1e8 / collateral) + int256(rawAdjustedThreshold) - 1e8;

        return int192(openPrice + profitP * openPrice / (1e6 * int256(uint256(leverage))) + 1e18);
    }

    /// @dev Registers this test contract as `tradesUpKeep` so it can drive
    ///      `OstiumTrading.executeAutomationOrder` directly. `_onlyTradesUpKeep` is a bare
    ///      `msg.sender == registry.getContractAddress('tradesUpKeep')` check and
    ///      `OstiumRegistry.registerContract` only demands the address have code, so the real
    ///      `OstiumTradesUpKeep` — which does nothing but forward — buys nothing here.
    function _becomeTradesUpKeep() internal {
        bytes32[] memory names = new bytes32[](1);
        address[] memory addrs = new address[](1);
        names[0] = "tradesUpKeep";
        addrs[0] = address(this);
        vm.prank(gov);
        IOstiumRegistry(d.registry).registerContracts(names, addrs);
    }

    /// @dev Retire the open position through its own take-profit, exactly as a keeper would:
    ///      request the price, then deliver a report that trips the trigger.
    function _executeTp(int192 price) internal {
        vm.recordLogs();
        IOstiumTrading(d.trading).executeAutomationOrder(
            IOstiumTradingStorage.LimitOrder.TP, trader, 0, 0, block.timestamp
        );
        (uint256 orderId, uint32 timestamp) = _lastPriceRequest();
        _deliver(orderId, _signed(timestamp, price));
    }

    /// @dev The cancel reason on the last `MarketCloseCanceled` in the recorded logs.
    function _lastCloseCancelReason() internal returns (IOstiumTradingCallbacks.CancelReason) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("MarketCloseCanceled(uint256,uint256,address,uint256,uint256,uint8)");
        for (uint256 j = logs.length; j > 0; j--) {
            if (logs[j - 1].topics.length > 0 && logs[j - 1].topics[0] == sig) {
                (,, IOstiumTradingCallbacks.CancelReason reason) =
                    abi.decode(logs[j - 1].data, (uint256, uint256, IOstiumTradingCallbacks.CancelReason));
                return reason;
            }
        }
        revert("no MarketCloseCanceled emitted");
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

    // -------------------------------------------------------------------------------------
    // The fix
    // -------------------------------------------------------------------------------------

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

    /// Notional is the protocol's invariant (see removeCollateral, OstiumTrading.sol). Charging
    /// the bond lowers collateral, so leverage MUST rise to keep collateral x leverage fixed.
    /// Subtracting collateral alone would delete `leverage x bond` of exposure with no fill.
    function test_chargingTheBondRaisesLeverageAndPreservesNotional() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        uint256 collateralBefore = _openCollateral();
        uint32 leverageBefore = _openLeverage();
        uint256 notionalBefore = collateralBefore * leverageBefore;

        _requestCloseAndCancel(FULL);

        uint256 collateralAfter = _openCollateral();
        uint32 leverageAfter = _openLeverage();

        assertEq(collateralBefore - collateralAfter, _bond(), "exactly one bond must leave collateral");
        assertGt(leverageAfter, leverageBefore, "leverage must rise as collateral falls");
        assertApproxEqRel(
            collateralAfter * leverageAfter,
            notionalBefore,
            1e15,
            "notional must survive the charge to within rounding"
        );
    }

    /// The leverage cap is NOT a reason to waive. `maxLeverage` constrains a leverage the TRADER
    /// asked for — at open, or by removing collateral — not a protocol fee that the trader does
    /// not choose. Waiving on it made a position opened AT the cap permanently exempt, which made
    /// close-request spam permanently free against it: request, let the report come back market
    /// closed, repeat, forever, for the price of gas.
    ///
    /// Measured before the fix over 25 back-to-back cycles: devFees delta 0, collateral delta 0.
    function test_bondIsStillChargedAtTheLeverageCap() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAtMaxLeverage();
        _drainTraderUsdw();

        uint32 cap = _maxLeverage();
        assertEq(_openLeverage(), cap, "precondition: the position must sit exactly at the cap");

        uint256 devBefore = _devFees();
        uint256 collateralBefore = _openCollateral();

        uint256 cycles = 5;
        for (uint256 n = 0; n < cycles; n++) {
            _requestCloseAndCancel(FULL);
        }

        assertEq(_devFees(), devBefore + cycles * _bond(), "every cancelled close must cost one bond");
        assertEq(
            collateralBefore - _openCollateral(), cycles * _bond(), "each bond must come out of collateral"
        );
        assertGt(_openLeverage(), cap, "leverage rises past the cap, which is the point: notional is fixed");
    }

    /// The first guard: a position too small to pay the bond. Reached by partially closing down
    /// to it at half the cap, where `pairMinLevPos` leaves slack — see `_openWithCollateralBelow`.
    /// Deliberately NOT at max leverage: both waive conditions would hold there and only source
    /// ordering would decide which one fired, so the test would pass without exercising its name.
    function test_bondIsWaivedWhenCollateralIsBelowIt() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openWithCollateralBelow(_bond());
        _drainTraderUsdw();

        assertLt(_openLeverage(), _maxLeverage(), "precondition: the cap must not be in play here");

        uint256 devBefore = _devFees();
        uint256 collateralBefore = _openCollateral();
        _requestCloseAndCancel(FULL);

        assertEq(_devFees(), devBefore, "a position too small to pay the bond must not be charged");
        assertEq(_openCollateral(), collateralBefore, "a waived bond must leave collateral untouched");
    }

    /// The second guard, and the one that has teeth. `liqMarginValue` is a function of NOTIONAL,
    /// which the recompute holds FIXED — so it does not move, while `tradeValue` falls by the
    /// whole bond. A trader partially closing a losing position to de-risk can therefore be made
    /// liquidatable by the fee itself, and then loses the entire remainder to `liquidationFee`.
    ///
    /// The state: half the cap (so the leverage recompute is provably not what rejects the bond),
    /// closed 50% at a price that leaves the remainder exactly half a bond above its liquidation
    /// margin. Solvent, so the close is not a liquidation — but with less than one bond of
    /// headroom, so the charge must be waived.
    function test_bondIsWaivedWhenItWouldPushThePositionUnderLiquidation() public {
        _configureAll();
        _fundTrader(10_000e6);

        uint32 leverage = _maxLeverage() / 2;
        _openAtLeverage(leverage, 1000e6);

        uint256 collateral = _openCollateral();
        uint256 remaining = collateral - collateral * (FULL / 2) / FULL;
        int192 mid = _midPriceLeavingHeadroom(remaining, leverage, _bond() / 2);

        uint256 devBefore = _devFees();
        uint256 groupBefore = _groupCollateral();
        _requestCloseAndFillAt(FULL / 2, mid);

        assertEq(_devFees(), devBefore, "a bond that would liquidate the remainder must be waived");
        assertEq(_openCollateral(), remaining, "only the partial close itself may move collateral");
        assertEq(_openLeverage(), leverage, "a waived bond must not touch leverage either");
        assertEq(
            groupBefore - _groupCollateral(),
            collateral - remaining,
            "group collateral must fall by the closed portion and nothing more"
        );

        // The state actually reached, asserted rather than assumed: still solvent, by less than
        // one bond. `mid - 1e18` is the bid, which is what a long closes against. Checked after
        // the assertions above so that a regression reports the defect rather than the setup —
        // against the unfixed contracts this same reading is NEGATIVE, which is the finding:
        // the fee itself had made the position liquidatable.
        int256 headroom = _headroomAt(_openCollateral(), _openLeverage(), mid - 1e18);
        assertGt(headroom, 0, "the remainder must still be above its liquidation margin");
        assertLt(headroom, int256(_bond()), "... by less than one bond, or the waive proves nothing");
    }

    /// Raising leverage moves the max-gain price, so a take-profit parked at the old maximum
    /// becomes unreachable: the TP order never fires in that band while the trader keeps paying
    /// rollover. `handleRemoveCollateral` — the other place leverage is recomputed against a fixed
    /// notional — calls `correctTp`/`correctToNullSl` for exactly this reason. So does the bond.
    function test_chargingTheBondCorrectsTheTakeProfit() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        uint192 openPrice = _openPrice();
        uint192 tpBefore = _openTp();
        uint32 stampBefore = _tradeInfo().tpLastUpdated;
        assertGt(tpBefore, 0, "precondition: registerTrade parks tp at the max-gain price, never 0");

        vm.warp(block.timestamp + 5); // so a re-stamped tpLastUpdated is observable
        _requestCloseAndCancel(FULL);

        uint32 leverage = _openLeverage();
        // `TradingCallbacksLib.correctTp` recomputes the max-gain price as
        // `openPrice + openPrice * MAX_GAIN_P / leverage`, with MAX_GAIN_P = 900.
        assertEq(
            _openTp(),
            openPrice + uint192(uint256(openPrice) * 900 / leverage),
            "tp must be the max-gain price for the NEW leverage"
        );
        assertLt(_openTp(), tpBefore, "a higher leverage means a nearer max-gain price");

        // The interaction this inherits from handleRemoveCollateral, stated so it cannot regress
        // silently: updateTrade routes tp through _updateTp, which re-stamps tpLastUpdated, and
        // OstiumTrading.executeAutomationOrder returns NO_TP for any report timestamped at or
        // before that stamp. Same behaviour as handleRemoveCollateral today, by design.
        assertGt(_tradeInfo().tpLastUpdated, stampBefore, "correcting tp re-stamps tpLastUpdated");
        assertEq(uint256(_tradeInfo().tpLastUpdated), block.timestamp, "the stamp is the current block");
    }

    /// C3. A TP/SL/LIQ automation close can retire trade A while A's own market close is still in
    /// flight, and `firstEmptyTradeIndex` hands the freed slot straight to trade B. The stored
    /// tradeId check has to run on the MARKET_CLOSED branch too, or B pays A's bond and has its
    /// leverage raised to fund a close it never asked for.
    function test_aBondNeverLandsOnTheTradeThatReplacedTheOneItWasFor() public {
        _configureAll();
        _becomeTradesUpKeep();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        uint256 tradeIdA = _tradeInfo().tradeId;

        // Park A's take-profit just above spot so a keeper can trip it in this block.
        vm.prank(trader);
        IOstiumTrading(d.trading).updateTp(0, 0, uint192(uint256(int256(BTC_65K))) + 100e18);

        // A close for A goes in flight.
        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarket(0, 0, FULL, uint192(uint256(int256(BTC_65K))), 100);
        (uint256 orderIdA, uint32 timestampA) = _lastPriceRequest();

        // A is retired underneath it by its own TP. Nothing rejects this: executeAutomationOrder
        // only checks the TP trigger, not PENDING_CLOSE (TradingLib.checkNoPendingTrigger).
        _executeTp(BTC_65K + 200e18);
        assertEq(_openCollateral(), 0, "precondition: A's slot must actually be free");

        // B takes the freed index.
        _openAndFill(2000e6);
        assertTrue(_tradeInfo().tradeId != tradeIdA, "precondition: B must be a different trade");

        uint256 collateralB = _openCollateral();
        uint32 leverageB = _openLeverage();
        uint256 devBefore = _devFees();
        uint256 groupBefore = _groupCollateral();

        // A's report finally lands, market closed.
        vm.recordLogs();
        _deliver(orderIdA, _marketClosedReport(timestampA));

        assertEq(
            uint8(_lastCloseCancelReason()),
            uint8(IOstiumTradingCallbacks.CancelReason.WRONG_TRADE),
            "a report for a retired trade must cancel WRONG_TRADE, not MARKET_CLOSED"
        );
        assertEq(_devFees(), devBefore, "B must not pay A's bond");
        assertEq(_openCollateral(), collateralB, "B's collateral must be untouched");
        assertEq(_openLeverage(), leverageB, "B's leverage must be untouched");
        assertEq(_groupCollateral(), groupBefore, "group collateral must be untouched");
    }

    /// Every close path in sequence, asserted on the values that actually move.
    ///
    /// The charge moves no tokens at all — it decrements `collateral` and increments `devFees`,
    /// both inside `OstiumTradingStorage` — so a balance-conservation check across trader, storage
    /// and vault cannot fail for any defect in this change and is not the assertion here. These
    /// are: `devFees`, the position's `collateral` and `leverage`, and the pair's group
    /// collateral, step by step. Conservation is still checked at the end, as the weaker
    /// backstop it is.
    function test_everyClosePathMovesExactlyTheRightNumbers() public {
        _configureAll();
        _fundTrader(10_000e6);

        // The vault is the third account, not an afterthought: closing pays rollover and funding
        // fees to it (TradingCallbacksLib.executeUnregisterTrade), so trader+storage alone is not
        // a closed system and would show a false leak of exactly those fees.
        uint256 totalBefore = _systemUsdw();
        uint256 bond = _bond();

        _openAndFill(1000e6);
        uint256 collateral = _openCollateral();
        uint32 leverage = _openLeverage();
        uint256 devFees = _devFees();
        uint256 group = _groupCollateral();
        assertEq(group, collateral, "group collateral starts as the one open position's collateral");

        // 1. A cancelled close: one bond out of the position, leverage up, no position closed.
        _requestCloseAndCancel(FULL);
        assertEq(_devFees(), devFees + bond, "a cancelled close credits exactly one bond to devFees");
        assertEq(_openCollateral(), collateral - bond, "... debited from the position's collateral");
        assertEq(_groupCollateral(), group - bond, "... and from group collateral, in lockstep");
        assertGt(_openLeverage(), leverage, "... with leverage raised to hold notional fixed");
        collateral = _openCollateral();
        leverage = _openLeverage();
        devFees = _devFees();
        group = _groupCollateral();

        // 2. A partial close: the closed half leaves, then one more bond out of the remainder.
        _requestCloseAndFill(FULL / 2);
        uint256 closed = collateral - collateral * (FULL / 2) / FULL; // what the close itself left
        assertEq(_devFees(), devFees + bond, "a partial close also keeps exactly one bond");
        assertEq(_openCollateral(), closed - bond, "the bond comes out of what the close left behind");
        assertEq(_groupCollateral(), group - (collateral - closed) - bond, "group tracks both debits");
        assertGt(_openLeverage(), leverage, "the bond raises leverage on the remainder too");
        devFees = _devFees();

        // 3. A full close: nothing is left to charge, and nothing is charged.
        _requestCloseAndFill(FULL);
        assertEq(_devFees(), devFees, "a full close is bond-neutral");
        assertEq(_openCollateral(), 0, "a full close clears the position");
        assertEq(_groupCollateral(), 0, "and clears its group collateral");

        assertEq(_systemUsdw(), totalBefore, "USDW must be conserved across trader, storage and vault");
    }

    /// The design's headline parity assertion: this change must not alter what a full close pays.
    ///
    /// Before it, the trader paid one bond from the wallet at request time and got that same bond
    /// back at execution; the two cancelled out exactly, so the net payout was the trade value and
    /// nothing else. After it, neither leg happens. `_expectedFullClosePayout` measures the payout
    /// by actually running the close against the live position and rolling the state back — the
    /// contract asked directly, rather than the contract's own fee formulas replayed against
    /// themselves — and the drained-wallet close must match it to the unit.
    function test_fullClosePayoutMatchesWhatThePreChangeContractsPaid() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        uint256 expected = _expectedFullClosePayout();
        assertGt(expected, 0, "precondition: the measurement must have actually run a close");

        uint256 devBefore = _devFees();
        _drainTraderUsdw();
        _requestCloseAndFill(FULL);

        assertEq(
            IERC20(d.collateral).balanceOf(trader),
            expected,
            "a full close must pay exactly what it paid before the bond moved off the wallet"
        );
        assertEq(_devFees(), devBefore, "and must be bond-neutral, which is what makes those equal");
    }

    /// The end-to-end statement of the whole change: start with nothing in the wallet, finish
    /// with the position closed and the money returned. This is the defect, inverted.
    function test_aDrainedTraderEndsWithTheirMoneyBack() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);
        _drainTraderUsdw();

        assertEq(IERC20(d.collateral).balanceOf(trader), 0, "precondition: the wallet must be empty");

        _requestCloseAndFill(FULL);

        assertEq(_openCollateral(), 0, "the position must be closed");
        assertGt(IERC20(d.collateral).balanceOf(trader), 0, "the trader must be paid out");
    }

    /// Every account USDW can legitimately sit in during a close: the trader, the storage that
    /// escrows collateral and accrues devFees, and the vault that receives rollover/funding.
    function _systemUsdw() internal view returns (uint256) {
        return IERC20(d.collateral).balanceOf(trader) + IERC20(d.collateral).balanceOf(d.tradingStorage)
            + IERC20(d.collateral).balanceOf(d.vault);
    }

    /// @notice The stop-loss must survive a bond charge.
    /// @dev Regression for a defect the fix wave introduced: correcting tp/sl by copying
    ///      handleRemoveCollateral's `correctToNullSl` DELETED a stop sitting at the widest allowed
    ///      distance. Measured before the fix: sl 59,475.915 -> 0 on a single cancelled close.
    ///      Not an edge case — TradingCallbacksLib.correctSl clamps any wider stop to exactly that
    ///      boundary at registration, so every "widest stop" position sits on it by construction.
    function test_aBondChargeReClampsTheStopLossInsteadOfDeletingIt() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        // The widest stop the contract accepts: openPrice - openPrice * maxSl_P / leverage.
        uint8 maxSlP = IOstiumTradingCallbacks(d.callbacks).maxSl_P();
        uint192 openPrice = _openPrice();
        uint192 widestSl = uint192(uint256(openPrice) - (uint256(openPrice) * maxSlP) / _openLeverage());

        vm.prank(trader);
        IOstiumTrading(d.trading).updateSl(0, 0, widestSl);
        uint192 slBefore = _openSl();
        assertGt(slBefore, 0, "precondition: the stop must be armed before the charge");

        _requestCloseAndCancel(FULL);

        uint192 slAfter = _openSl();
        assertGt(slAfter, 0, "a bond charge must not delete the trader's stop-loss");
        assertLt(slAfter, _openPrice(), "a long's stop must stay below its entry");
        // For a long the stop sits BELOW entry, so re-clamping to the higher leverage's narrower
        // boundary moves it UP. Tighter, not wider — and still armed, which is the whole point.
        assertGe(slAfter, slBefore, "the stop must be pulled to the new boundary, not left past it");
    }

    /// @notice On MARKET_CLOSED the liquidation guard must value the position at the last observed
    ///         oracle price, not at its own entry.
    /// @dev Valued at entry, profitP is 0 by construction, so the guard sees ~97.5% headroom however
    ///      far underwater the position is and would charge one tick from liquidation. Drive the
    ///      mark far against the position, then cancel: the charge must be waived.
    function test_marketClosedValuesThePositionAtTheLastOraclePriceNotItsEntry() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAtLeverage(_maxLeverage(), 1000e6);
        _drainTraderUsdw();

        // lastTradePrice is only written by an executed trade (OstiumOpenPnl.updateAccTotalPnl),
        // so move it with a 1% partial close at the lower price. That also leaves a position
        // behind to charge, which is what the cancel below needs.
        _requestCloseAndFillAt(FULL / 100, BTC_65K * 97 / 100);

        uint256 devBefore = _devFees();
        uint256 collateralBefore = _openCollateral();
        _requestCloseAndCancel(FULL);

        assertEq(_devFees(), devBefore, "a position underwater at the last oracle price must not be charged");
        assertEq(_openCollateral(), collateralBefore, "a waived charge must leave collateral untouched");
    }
}
