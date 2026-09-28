// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Test.sol";

import {TestnetTrading} from "../helpers/TestnetTrading.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumTradingCallbacks} from "../../src/vendor/ostium/interfaces/IOstiumTradingCallbacks.sol";
import {IOstiumPairsStorage} from "../../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {WhitespacePriceUpKeep} from "../../src/oracle/WhitespacePriceUpKeep.sol";
import {IOstiumPriceUpKeep} from "../../src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol";

/// @notice `OstiumTrading` + `OstiumTradingCallbacks` on the system exactly as the testnet deploy
///         script builds it: every request check, every cancel reason the testnet configuration
///         can reach, limit/stop orders through `OstiumTradesUpKeep`, TP/SL automation,
///         collateral top-up/removal, partial and full close, the timeouts, pause/done, the
///         per-pair trade cap and market isolation.
contract TradingTest is TestnetTrading {
    address internal trader = address(0x7AA);
    address internal other = address(0x7AB);

    IOstiumTradingStorage.LimitOrder internal constant OPEN = IOstiumTradingStorage.LimitOrder.OPEN;
    IOstiumTradingStorage.LimitOrder internal constant TP = IOstiumTradingStorage.LimitOrder.TP;
    IOstiumTradingStorage.LimitOrder internal constant SL = IOstiumTradingStorage.LimitOrder.SL;
    IOstiumTradingStorage.OpenOrderType internal constant MARKET = IOstiumTradingStorage.OpenOrderType.MARKET;
    IOstiumTradingStorage.OpenOrderType internal constant LIMIT = IOstiumTradingStorage.OpenOrderType.LIMIT;
    IOstiumTradingStorage.OpenOrderType internal constant STOP = IOstiumTradingStorage.OpenOrderType.STOP;

    function setUp() public {
        _setUpTestnet();
        _fundTrader(trader, 1_000_000e6);
        _fundTrader(other, 1_000_000e6);
    }

    // =====================================================================================
    // Market open — success
    // =====================================================================================

    /// @notice 1,000 USDW at 10x on BTC: collateral escrowed at request; at fill the 0.06% taker
    ///         fee (6 USDW, half to the vault), the $1 oracle fee, the ask-side fill, the
    ///         max-gain TP, the OI and the group collateral are all exactly as specified.
    function test_marketOpen_fillsAtTheAskAndAccountsEveryUsdw() public {
        uint256 traderBefore = _bal(trader);
        uint256 storageBefore = _bal(d.tradingStorage);
        uint256 vaultBefore = _bal(d.vault);
        uint256 devBefore = ts.devFees();

        (uint256 orderId, uint32 t) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, true, 0), 100);
        assertEq(_bal(trader), traderBefore - 1_000e6, "collateral pulled at request");
        assertEq(_bal(d.tradingStorage), storageBefore + 1_000e6, "escrowed in storage");
        assertEq(ts.pendingMarketOpenCount(trader, BTC), 1, "pending open counted");
        assertEq(ts.pendingOrderIdsCount(trader), 1, "pending order id stored");

        _deliverAt(orderId, BTC, t, _basePrice(BTC));

        IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, BTC, 0);
        uint256 fill = _spreadFill(_basePrice(BTC), true, true);
        assertEq(fill, 65_006.5e18, "one basis point above mid");
        assertEq(tr.openPrice, fill, "long fills at the ask");
        assertEq(tr.collateral, 993e6, "1000 - 3 dev - 3 vault - 1 oracle");
        assertEq(tr.leverage, 1_000, "leverage kept");
        assertEq(tr.tp, fill + fill * 900e6 / 1e6 / 1_000, "tp defaults to the 900% max gain price");
        assertEq(tr.sl, 0, "no stop loss");
        assertEq(ts.devFees(), devBefore + 3e6 + ORACLE_FEE, "dev half + oracle fee");
        assertEq(_bal(d.vault), vaultBefore + 3e6, "vault half of the fee");
        assertEq(_bal(d.tradingStorage), storageBefore + 997e6, "collateral + dev fees stay in storage");
        assertEq(_oi(BTC, true), uint256(993e6) * 1e12 * 1_000 / 100 * 1e18 / fill, "long OI in units");
        assertEq(_oi(BTC, false), 0, "no short OI");
        assertEq(ps.groupCollateral(BTC, true), 993e6, "group collateral");
        assertEq(ts.pendingMarketOpenCount(trader, BTC), 0, "pending cleared");
        assertEq(ts.pendingOrderIdsCount(trader), 0, "order id cleared");
        assertEq(ts.openTradesCount(trader, BTC), 1, "one open trade");
        assertEq(ts.totalOpenTradesCount(), 1, "global count");
    }

    function test_marketOpen_shortFillsAtTheBid() public {
        _open(trader, BTC, 1_000e6, 1_000, false);
        IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, BTC, 0);
        assertEq(tr.openPrice, _spreadFill(_basePrice(BTC), false, true), "short fills at the bid");
        assertEq(tr.openPrice, 64_993.5e18, "one basis point below mid");
        assertEq(_oi(BTC, false), uint256(993e6) * 1e12 * 1_000 / 100 * 1e18 / tr.openPrice, "short OI");
        assertEq(_oi(BTC, true), 0, "no long OI");
    }

    // =====================================================================================
    // Market open — request checks
    // =====================================================================================

    function _openReverts(IOstiumTradingStorage.Trade memory t, IOstiumTradingStorage.OpenOrderType kind, uint256 slip, bytes memory err)
        internal
    {
        vm.expectRevert(err);
        vm.prank(t.trader);
        trading.openTrade(t, _noBuilder(), kind, slip);
    }

    function test_openTrade_rejectsMalformedRequests() public {
        uint192 p = _upx(BTC);
        bytes memory wrong = abi.encodeWithSelector(IOstiumTrading.WrongParams.selector);
        // zero open price
        _openReverts(_tradeFull(trader, BTC, 1_000e6, 1_000, true, 0, 0, 0), MARKET, 100, wrong);
        // market slippage must be in (0, 100%)
        _openReverts(_tradeFull(trader, BTC, 1_000e6, 1_000, true, p, 0, 0), MARKET, 0, wrong);
        _openReverts(_tradeFull(trader, BTC, 1_000e6, 1_000, true, p, 0, 0), MARKET, 10_000, wrong);
        // limit/stop orders carry no slippage
        _openReverts(_tradeFull(trader, BTC, 1_000e6, 1_000, true, p, 0, 0), LIMIT, 1, wrong);
        _openReverts(_tradeFull(trader, BTC, 1_000e6, 1_000, true, p, 0, 0), STOP, 1, wrong);
        // builder fee above 0.5%
        vm.expectRevert(wrong);
        vm.prank(trader);
        trading.openTrade(
            _tradeFull(trader, BTC, 1_000e6, 1_000, true, p, 0, 0),
            IOstiumTradingStorage.BuilderFee({builder: other, builderFee: 500_001}),
            MARKET,
            100
        );
        // an unlisted pair
        _openReverts(
            _tradeFull(trader, 4, 1_000e6, 1_000, true, p, 0, 0),
            MARKET,
            100,
            abi.encodeWithSelector(IOstiumTrading.PairNotListed.selector, uint16(4))
        );
        assertEq(_bal(d.tradingStorage), 0, "nothing escrowed by any rejected request");
    }

    function test_openTrade_rejectsLeverageOutsideThePairBounds() public {
        uint192 p = _upx(BTC);
        _openReverts(
            _tradeFull(trader, BTC, 1_000e6, 0, true, p, 0, 0), MARKET, 100,
            abi.encodeWithSelector(IOstiumTrading.WrongLeverage.selector, uint32(0))
        );
        _openReverts(
            _tradeFull(trader, BTC, 1_000e6, 99, true, p, 0, 0), MARKET, 100,
            abi.encodeWithSelector(IOstiumTrading.WrongLeverage.selector, uint32(99))
        );
        _openReverts(
            _tradeFull(trader, BTC, 1_000e6, 10_001, true, p, 0, 0), MARKET, 100,
            abi.encodeWithSelector(IOstiumTrading.WrongLeverage.selector, uint32(10_001))
        );
        _openReverts(
            _tradeFull(trader, WBT, 1_000e6, 2_501, true, _upx(WBT), 0, 0), MARKET, 100,
            abi.encodeWithSelector(IOstiumTrading.WrongLeverage.selector, uint32(2_501))
        );
        // the bounds themselves are accepted: 1x and 100x on BTC, 25x on WBT
        _requestOpen(_tradeFull(trader, BTC, 1_000e6, 100, true, p, 0, 0), 100);
        _requestOpen(_tradeFull(trader, BTC, 1_000e6, 10_000, true, p, 0, 0), 100);
        _requestOpen(_tradeFull(trader, WBT, 1_000e6, 2_500, true, _upx(WBT), 0, 0), 100);
        assertEq(ts.pendingMarketOpenCount(trader, BTC), 2, "both BTC bounds accepted");
        assertEq(ts.pendingMarketOpenCount(trader, WBT), 1, "WBT bound accepted");
    }

    function test_openTrade_rejectsCollateralAboveTheCapAndBelowFees() public {
        uint192 p = _upx(BTC);
        _openReverts(
            _tradeFull(trader, BTC, 1_000_000e6 + 1, 100, true, p, 0, 0), MARKET, 100,
            abi.encodeWithSelector(IOstiumTrading.AboveMaxAllowedCollateral.selector)
        );
        // $1 at 1x: the $1 oracle fee alone eats it
        _openReverts(
            _tradeFull(trader, BTC, 1e6, 100, true, p, 0, 0), MARKET, 100,
            abi.encodeWithSelector(IOstiumTrading.BelowFees.selector)
        );
    }

    /// @notice minLevPos is $10 of post-fee notional. At 1x, 11.006603 USDW leaves exactly
    ///         10.000000 after the $1 oracle fee and 0.006603 of taker fee; one micro-USDW less
    ///         does not.
    function test_openTrade_minimumPositionSizeBoundary() public {
        uint192 p = _upx(BTC);
        _openReverts(
            _tradeFull(trader, BTC, 11_006_602, 100, true, p, 0, 0), MARKET, 100,
            abi.encodeWithSelector(IOstiumTrading.BelowMinLevPos.selector)
        );
        _requestOpen(_tradeFull(trader, BTC, 11_006_603, 100, true, p, 0, 0), 100);
        assertEq(ts.pendingMarketOpenCount(trader, BTC), 1, "exactly $10 post-fee is accepted");
    }

    function test_openTrade_rejectsTpAndSlOnTheWrongSide() public {
        uint192 p = _upx(BTC);
        bytes memory wrongTp = abi.encodeWithSelector(IOstiumTrading.WrongTP.selector);
        bytes memory wrongSl = abi.encodeWithSelector(IOstiumTrading.WrongSL.selector);
        _openReverts(_tradeFull(trader, BTC, 1_000e6, 1_000, true, p, p, 0), MARKET, 100, wrongTp);
        _openReverts(_tradeFull(trader, BTC, 1_000e6, 1_000, false, p, p, 0), MARKET, 100, wrongTp);
        _openReverts(_tradeFull(trader, BTC, 1_000e6, 1_000, true, p, 0, p), MARKET, 100, wrongSl);
        _openReverts(_tradeFull(trader, BTC, 1_000e6, 1_000, false, p, 0, p), MARKET, 100, wrongSl);
        // one wei on the right side is accepted
        _requestOpen(_tradeFull(trader, BTC, 1_000e6, 1_000, true, p, p + 1, p - 1), 100);
        _requestOpen(_tradeFull(trader, BTC, 1_000e6, 1_000, false, p, p - 1, p + 1), 100);
        assertEq(ts.pendingMarketOpenCount(trader, BTC), 2, "both accepted");
    }

    function test_openTrade_rejectsAboveMaxPendingMarketOrders() public {
        vm.prank(gov);
        ts.setMaxPendingMarketOrders(2);
        _requestOpen(_trade(trader, BTC, 100e6, 1_000, true, 0), 100);
        _requestOpen(_trade(trader, ETH, 100e6, 1_000, true, 0), 100);
        _openReverts(
            _trade(trader, SOL, 100e6, 1_000, true, 0), MARKET, 100,
            abi.encodeWithSelector(IOstiumTrading.MaxPendingMarketOrdersReached.selector, trader)
        );
        assertEq(ts.pendingOrderIdsCount(trader), 2, "cap holds across pairs");
    }

    // =====================================================================================
    // Market open — every cancel reason the testnet configuration reaches
    // =====================================================================================

    /// @dev Asserts the refund path of a cancelled open: collateral minus the $1 oracle fee back
    ///      to the trader, the fee to devFees, nothing stored.
    function _assertOpenCanceled(
        uint256 orderId,
        uint16 pairIndex,
        uint256 collateral,
        IOstiumTradingCallbacks.CancelReason reason,
        bytes memory report
    ) internal {
        uint256 traderBefore = _bal(trader);
        uint256 devBefore = ts.devFees();
        uint256 storageBefore = _bal(d.tradingStorage);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.MarketOpenCanceled(orderId, trader, pairIndex, reason);
        _deliver(orderId, report);
        assertEq(_bal(trader), traderBefore + collateral - ORACLE_FEE, "refund minus oracle fee");
        assertEq(ts.devFees(), devBefore + ORACLE_FEE, "oracle fee kept");
        assertEq(_bal(d.tradingStorage), storageBefore - (collateral - ORACLE_FEE), "escrow released");
        assertEq(ts.pendingMarketOpenCount(trader, pairIndex), 0, "pending cleared");
        assertEq(ts.openTradesCount(trader, pairIndex), 0, "no trade stored");
    }

    function test_marketOpenCancel_slippageLongAndShort() public {
        (uint256 id, uint32 t) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, true, 0), 100);
        _assertOpenCanceled(id, BTC, 1_000e6, IOstiumTradingCallbacks.CancelReason.SLIPPAGE, _report(BTC, t, _px(BTC, 108)));
        (id, t) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, false, 0), 100);
        _assertOpenCanceled(id, BTC, 1_000e6, IOstiumTradingCallbacks.CancelReason.SLIPPAGE, _report(BTC, t, _px(BTC, -108)));
    }

    /// @notice The slippage bound is inclusive. On the 1e-14 price grid where the fixture's
    ///         one-basis-point half spread is exact, the last mid whose ask-side fill is still
    ///         <= wanted + 1% fills and the next grid step cancels.
    function test_marketOpenSlippage_boundaryIsInclusive() public {
        uint256 limit = _upx(BTC) + uint256(_upx(BTC)) * 100 / 100 / 100;
        uint256 grid = 10_000;
        int192 p = int192(int256((limit * grid / (grid + 1)) / grid * grid));
        int192 next = p + int192(int256(grid));
        assertLe(_spreadFill(p, true, true), limit, "p fills inside the bound");
        assertGt(_spreadFill(next, true, true), limit, "the next step is outside");

        uint256 snap = vm.snapshotState();
        (uint256 id, uint32 t) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, true, 0), 100);
        _deliverAt(id, BTC, t, p);
        assertEq(ts.getOpenTrade(trader, BTC, 0).openPrice, _spreadFill(p, true, true), "filled at the bound");
        vm.revertToState(snap);

        (id, t) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, true, 0), 100);
        _assertOpenCanceled(id, BTC, 1_000e6, IOstiumTradingCallbacks.CancelReason.SLIPPAGE, _report(BTC, t, next));
    }

    function test_marketOpenCancel_tpReached() public {
        (uint256 id, uint32 t) =
            _requestOpen(_tradeFull(trader, BTC, 1_000e6, 1_000, true, _upx(BTC), 65_500e18, 0), 100);
        _assertOpenCanceled(id, BTC, 1_000e6, IOstiumTradingCallbacks.CancelReason.TP_REACHED, _report(BTC, t, 65_600e18));
    }

    function test_marketOpenCancel_slReached() public {
        (uint256 id, uint32 t) =
            _requestOpen(_tradeFull(trader, BTC, 1_000e6, 1_000, true, _upx(BTC), 0, 64_500e18), 100);
        _assertOpenCanceled(id, BTC, 1_000e6, IOstiumTradingCallbacks.CancelReason.SL_REACHED, _report(BTC, t, 64_400e18));
    }

    /// @notice WBT's 100k OI ceiling: 5,000 USDW at 25x is 125k of notional.
    function test_marketOpenCancel_exposureLimitsOnOpenInterest() public {
        (uint256 id, uint32 t) = _requestOpen(_trade(trader, WBT, 5_000e6, 2_500, true, 0), 500);
        _assertOpenCanceled(id, WBT, 5_000e6, IOstiumTradingCallbacks.CancelReason.EXPOSURE_LIMITS, _report(WBT, t, _basePrice(WBT)));
        assertEq(_oi(WBT, true), 0, "no OI written");
    }

    /// @notice The group (all four markets share it) may hold 20% of the vault's balance per
    ///         side: 21,000 USDW of collateral cancels even at 2x on a market with room.
    function test_marketOpenCancel_exposureLimitsOnGroupCollateral() public {
        assertEq(ps.groupMaxCollateral(BTC), 20_000e6, "20% of the 100k vault");
        (uint256 id, uint32 t) = _requestOpen(_trade(trader, BTC, 21_000e6, 200, true, 0), 500);
        _assertOpenCanceled(id, BTC, 21_000e6, IOstiumTradingCallbacks.CancelReason.EXPOSURE_LIMITS, _report(BTC, t, _basePrice(BTC)));
    }

    /// @notice Reachable at the deployed parameters: two same-block 1M round trips at 100x
    ///         push recent buy volume far enough above the 50k threshold that the third open's
    ///         impact x leverage exceeds `maxNegativePnlOnOpenP` (40%).
    function test_marketOpenCancel_priceImpactAtDeployedParameters() public {
        for (uint256 i = 0; i < 2; i++) {
            _openAt(trader, BTC, 10_000e6, 10_000, true, _basePrice(BTC));
            _closeAt(trader, BTC, 0, 0, _basePrice(BTC));
            assertEq(ts.openTradesCount(trader, BTC), 0, "round trip closed");
        }
        (uint256 buyVol,,) = pairInfos.pairDynamicSpreadState(BTC);
        assertEq(buyVol, 2 * uint256(9_399e6) * 10_000 * 1e10, "two post-fee 939,900 opens recorded");

        (uint256 id, uint32 t) = _requestOpen(_trade(trader, BTC, 10_000e6, 10_000, true, 0), 500);
        _assertOpenCanceled(id, BTC, 10_000e6, IOstiumTradingCallbacks.CancelReason.PRICE_IMPACT, _report(BTC, t, _basePrice(BTC)));
    }

    function test_marketOpenCancel_maxLeverageWhenGovLowersItInFlight() public {
        (uint256 id, uint32 t) = _requestOpen(_trade(trader, BTC, 100e6, 10_000, true, 0), 100);
        vm.prank(gov);
        ps.setPairMaxLeverage(BTC, 5_000);
        _assertOpenCanceled(id, BTC, 100e6, IOstiumTradingCallbacks.CancelReason.MAX_LEVERAGE, _report(BTC, t, _basePrice(BTC)));
    }

    function test_marketOpenCancel_pausedCallbacks() public {
        (uint256 id, uint32 t) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, true, 0), 100);
        vm.prank(manager);
        callbacks.pause();
        _assertOpenCanceled(id, BTC, 1_000e6, IOstiumTradingCallbacks.CancelReason.PAUSED, _report(BTC, t, _basePrice(BTC)));
    }

    function test_marketOpenCancel_marketClosed() public {
        (uint256 id, uint32 t) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, true, 0), 100);
        _assertOpenCanceled(id, BTC, 1_000e6, IOstiumTradingCallbacks.CancelReason.MARKET_CLOSED, _closedReport(BTC, t));
    }

    // =====================================================================================
    // Market open timeout
    // =====================================================================================

    function test_openTimeout_refundsInFullOnlyAfterElevenBlocksAndOnlyToTheOwner() public {
        uint256 before = _bal(trader);
        (uint256 id,) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, true, 0), 100);

        _advance(MARKET_TIMEOUT - 1);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WaitTimeout.selector, id));
        vm.prank(trader);
        trading.openTradeMarketTimeout(id);

        _advance(1);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NotYourOrder.selector, id, trader));
        vm.prank(other);
        trading.openTradeMarketTimeout(id);

        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NoTradeToTimeoutFound.selector, id + 99));
        vm.prank(trader);
        trading.openTradeMarketTimeout(id + 99);

        vm.prank(trader);
        trading.openTradeMarketTimeout(id);
        assertEq(_bal(trader), before, "full collateral back, no fee");
        assertEq(_bal(d.tradingStorage), 0, "escrow empty");
        assertEq(ts.pendingMarketOpenCount(trader, BTC), 0, "pending cleared");

        // the stale report can no longer fill anything
        (,,, IOstiumTradingStorage.Trade memory tr,) = _pending(id);
        assertEq(tr.trader, address(0), "order deleted");
    }

    function test_openTimeout_refusesACloseOrder() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        (uint256 id,) = _requestClose(trader, BTC, 0, 0, _upx(BTC), 100);
        _advance(MARKET_TIMEOUT);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NotOpenMarketTimeoutOrder.selector, id));
        vm.prank(trader);
        trading.openTradeMarketTimeout(id);
    }

    function _pending(uint256 id)
        internal
        view
        returns (uint256, uint192, uint32, IOstiumTradingStorage.Trade memory, uint16)
    {
        return ts.reqID_pendingMarketOrder(id);
    }

    // =====================================================================================
    // Close — partial, full, rejections, cancels, timeout
    // =====================================================================================

    function test_fullClose_releasesEverythingAndSplitsCollateralBetweenTraderAndVault() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 traderBefore = _bal(trader);
        uint256 vaultBefore = _bal(d.vault);
        uint256 storageBefore = _bal(d.tradingStorage);
        uint256 devBefore = ts.devFees();

        _closeAt(trader, BTC, 0, 0, _basePrice(BTC));

        assertEq(ts.getOpenTrade(trader, BTC, 0).leverage, 0, "trade deleted");
        assertEq(ts.openTradesCount(trader, BTC), 0, "count");
        assertEq(ts.totalOpenTradesCount(), 0, "global count");
        assertEq(_oi(BTC, true), 0, "OI released");
        assertEq(ps.groupCollateral(BTC, true), 0, "group collateral released");
        assertEq(ts.devFees(), devBefore, "a full close costs no bond");
        assertEq(_bal(d.tradingStorage), storageBefore - 993e6, "whole collateral leaves storage");
        uint256 toTrader = _bal(trader) - traderBefore;
        uint256 toVault = _bal(d.vault) - vaultBefore;
        assertEq(toTrader + toVault, 993e6, "collateral split between trader and vault, nothing lost");
        assertGt(toTrader, 990e6, "a flat round trip returns ~0.2% less than collateral");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, IOstiumTradingStorage.LimitOrder.PENDING_CLOSE), 0, "trigger cleared");
    }

    /// @notice Closing half: half the collateral and exactly half the OI leave; the one-dollar
    ///         bond is taken from the remaining position, whose notional is held fixed.
    function test_partialClose_halvesThePositionAndChargesTheBondFromWhatRemains() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 oiBefore = _oi(BTC, true);
        uint256 traderBefore = _bal(trader);
        uint256 vaultBefore = _bal(d.vault);
        uint256 devBefore = ts.devFees();

        _closeAt(trader, BTC, 0, 5_000, _basePrice(BTC));

        IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, BTC, 0);
        assertEq(tr.collateral, 496.5e6 - ORACLE_FEE, "half left, minus the bond");
        assertEq(tr.leverage, uint32(uint256(4_965e6) * 1e6 / (495.5e6) / 1e4), "fixed notional, higher leverage");
        assertEq(_oi(BTC, true), oiBefore - oiBefore * 496.5e6 / 993e6, "exactly half the OI released");
        assertEq(ts.devFees(), devBefore + ORACLE_FEE, "bond to dev fees");
        assertEq((_bal(trader) - traderBefore) + (_bal(d.vault) - vaultBefore), 496.5e6, "closed half split");
        assertEq(ps.groupCollateral(BTC, true), 495.5e6, "group collateral follows the trade");
    }

    function test_closeTradeMarket_rejectsMalformedRequests() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        bytes memory wrong = abi.encodeWithSelector(IOstiumTrading.WrongParams.selector);
        vm.startPrank(trader);
        vm.expectRevert(wrong);
        trading.closeTradeMarket(BTC, 0, 10_001, _upx(BTC), 100);
        vm.expectRevert(wrong);
        trading.closeTradeMarket(BTC, 0, 0, 0, 100);
        vm.expectRevert(wrong);
        trading.closeTradeMarket(BTC, 0, 0, _upx(BTC), 0);
        vm.expectRevert(wrong);
        trading.closeTradeMarket(BTC, 0, 0, _upx(BTC), 10_001);
        // the error reports the EMPTY slot's (pairIndex, index), which is always (0, 0)
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NoTradeFound.selector, trader, uint16(0), uint8(0)));
        trading.closeTradeMarket(ETH, 1, 0, _upx(BTC), 100);
        vm.stopPrank();

        _requestClose(trader, BTC, 0, 0, _upx(BTC), 100);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, BTC, uint8(0)));
        vm.prank(trader);
        trading.closeTradeMarket(BTC, 0, 0, _upx(BTC), 100);
    }

    function test_partialClose_rejectsARemainderBelowMinimumPosition() public {
        _open(trader, BTC, 20e6, 100, true); // ~19 USDW at 1x after fees
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.BelowMinLevPos.selector));
        vm.prank(trader);
        trading.closeTradeMarket(BTC, 0, 5_000, _upx(BTC), 100);
        // a full close of the same position is fine
        _closeAt(trader, BTC, 0, 0, _basePrice(BTC));
        assertEq(ts.openTradesCount(trader, BTC), 0, "closed");
    }

    function test_closeCancel_slippageChargesTheBondFromThePosition() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 devBefore = ts.devFees();
        (uint256 id, uint32 t) = _requestClose(trader, BTC, 0, 0, _upx(BTC), 100);
        uint256 tradeId = ts.getOpenTradeInfo(trader, BTC, 0).tradeId;

        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.MarketCloseCanceled(
            id, tradeId, trader, BTC, 0, IOstiumTradingCallbacks.CancelReason.SLIPPAGE
        );
        _deliverAt(id, BTC, t, _px(BTC, -200));

        IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, BTC, 0);
        assertEq(tr.collateral, 992e6, "bond out of collateral");
        assertEq(tr.leverage, uint32(uint256(9_930e6) * 1e6 / 992e6 / 1e4), "notional held fixed");
        assertEq(ts.devFees(), devBefore + ORACLE_FEE, "bond to dev fees");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, IOstiumTradingStorage.LimitOrder.PENDING_CLOSE), 0, "can close again");
    }

    function test_closeCancel_marketClosedChargesTheBond() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        (uint256 id, uint32 t) = _requestClose(trader, BTC, 0, 0, _upx(BTC), 100);
        uint256 tradeId = ts.getOpenTradeInfo(trader, BTC, 0).tradeId;
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.MarketCloseCanceled(
            id, tradeId, trader, BTC, 0, IOstiumTradingCallbacks.CancelReason.MARKET_CLOSED
        );
        _deliver(id, _closedReport(BTC, t));
        assertEq(ts.getOpenTrade(trader, BTC, 0).collateral, 992e6, "bond charged");
    }

    function test_closeTimeout_releasesThePendingCloseAndCanRetry() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 before = _bal(trader);
        (uint256 id,) = _requestClose(trader, BTC, 0, 0, _upx(BTC), 100);

        _advance(MARKET_TIMEOUT - 1);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WaitTimeout.selector, id));
        vm.prank(trader);
        trading.closeTradeMarketTimeout(id, false);

        _advance(1);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NotYourOrder.selector, id, trader));
        vm.prank(other);
        trading.closeTradeMarketTimeout(id, false);

        uint256 snap = vm.snapshotState();
        vm.prank(trader);
        trading.closeTradeMarketTimeout(id, false);
        assertEq(_bal(trader), before, "no USDW moves");
        assertEq(ts.getOpenTrade(trader, BTC, 0).collateral, 993e6, "position intact");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, IOstiumTradingStorage.LimitOrder.PENDING_CLOSE), 0, "unlocked");
        assertEq(ts.pendingOrderIdsCount(trader), 0, "no pending order");
        vm.revertToState(snap);

        // retry re-requests the same close in the same transaction
        vm.recordLogs();
        vm.prank(trader);
        trading.closeTradeMarketTimeout(id, true);
        (uint256 retryId, uint32 t) = _lastPriceRequest();
        assertGt(retryId, id, "a fresh order");
        assertEq(ts.pendingOrderIdsCount(trader), 1, "the retry is pending");
        _deliverAt(retryId, BTC, t, _basePrice(BTC));
        assertEq(ts.openTradesCount(trader, BTC), 0, "retry closed the position");
    }

    function test_closeTimeout_refusesAnOpenOrder() public {
        (uint256 id,) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, true, 0), 100);
        _advance(MARKET_TIMEOUT);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NotCloseMarketTimeoutOrder.selector, id));
        vm.prank(trader);
        trading.closeTradeMarketTimeout(id, false);
    }

    // =====================================================================================
    // LIMIT / STOP — place, update, cancel, trigger
    // =====================================================================================

    function test_placeLimit_escrowsCollateralAndStoresTheOrder() public {
        uint256 before = _bal(trader);
        vm.recordLogs();
        uint8 idx = _place(trader, BTC, 1_000e6, 1_000, true, 64_000e18, 0, 0, LIMIT);
        assertEq(idx, 0, "first limit slot");
        assertEq(_bal(trader), before - 1_000e6, "collateral escrowed");
        assertEq(_bal(d.tradingStorage), 1_000e6, "in storage");
        assertTrue(ts.hasOpenLimitOrder(trader, BTC, 0), "stored");
        assertEq(ts.openLimitOrdersCount(trader, BTC), 1, "counted");
        IOstiumTradingStorage.OpenLimitOrder memory o = ts.getOpenLimitOrder(trader, BTC, 0);
        assertEq(o.targetPrice, 64_000e18, "target");
        assertEq(uint8(o.orderType), uint8(LIMIT), "kind");
        assertEq(o.createdAt, vm.getBlockTimestamp(), "createdAt");
        assertEq(o.lastUpdated, vm.getBlockTimestamp(), "lastUpdated");
        assertEq(ts.limitOrderIds(trader, BTC, 0), 1, "first limit order id");
        assertFalse(_hasPriceRequest(vm.getRecordedLogs()), "no oracle request for a resting order");
    }

    function test_limitLong_executesWhenTheAskFillIsAtOrBelowTarget() public {
        _place(trader, BTC, 1_000e6, 1_000, true, 64_000e18, 0, 0, LIMIT);
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        _deliverAt(id, BTC, t, 63_900e18);

        IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, BTC, 0);
        assertEq(tr.openPrice, _spreadFill(63_900e18, true, true), "fills at the post-impact price, not the target");
        assertEq(tr.collateral, 993e6, "same fees as a market order");
        assertFalse(ts.hasOpenLimitOrder(trader, BTC, 0), "order consumed");
        assertEq(ts.openLimitOrdersCount(trader, BTC), 0, "count");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, OPEN), 0, "trigger cleared");
    }

    function test_limitLong_notHitLeavesTheOrderResting() public {
        _place(trader, BTC, 1_000e6, 1_000, true, 64_000e18, 0, 0, LIMIT);
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationOpenOrderCanceled(id, trader, BTC, IOstiumTradingCallbacks.CancelReason.NOT_HIT);
        // mid exactly at target: the ask-side fill is one basis point above it
        _deliverAt(id, BTC, t, 64_000e18);
        assertTrue(ts.hasOpenLimitOrder(trader, BTC, 0), "still resting");
        assertEq(ts.openTradesCount(trader, BTC), 0, "nothing opened");
        assertEq(_bal(d.tradingStorage), 1_000e6, "collateral still escrowed, no fee");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, OPEN), 0, "trigger cleared for the next attempt");
    }

    function test_limitShort_executesWhenTheBidFillIsAtOrAboveTarget() public {
        _place(trader, BTC, 1_000e6, 1_000, false, 66_000e18, 0, 0, LIMIT);
        uint256 snap = vm.snapshotState();
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        _deliverAt(id, BTC, t, 66_000e18); // bid 65,993.4 < target
        assertEq(ts.openTradesCount(trader, BTC), 0, "not hit at mid == target");
        vm.revertToState(snap);
        (id, t) = _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        _deliverAt(id, BTC, t, 66_100e18);
        assertEq(ts.getOpenTrade(trader, BTC, 0).openPrice, _spreadFill(66_100e18, false, true), "short filled at the bid");
    }

    /// @notice A STOP compares the oracle mid (not the post-impact fill) with its target.
    function test_stopLong_executesAtOrAboveTargetOnTheMid() public {
        _place(trader, BTC, 1_000e6, 1_000, true, 66_000e18, 0, 0, STOP);
        uint256 snap = vm.snapshotState();
        (uint256 id, uint32 t) = _triggerNow(liquidatorB, trader, BTC, 0, OPEN);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationOpenOrderCanceled(id, trader, BTC, IOstiumTradingCallbacks.CancelReason.NOT_HIT);
        _deliverAt(id, BTC, t, 66_000e18 - 1);
        assertTrue(ts.hasOpenLimitOrder(trader, BTC, 0), "one wei below: not hit");
        vm.revertToState(snap);

        (id, t) = _triggerNow(liquidatorB, trader, BTC, 0, OPEN);
        _deliverAt(id, BTC, t, 66_000e18);
        assertEq(ts.getOpenTrade(trader, BTC, 0).openPrice, _spreadFill(66_000e18, true, true), "exactly at target: hit");
        assertFalse(ts.hasOpenLimitOrder(trader, BTC, 0), "consumed");
    }

    function test_stopShort_executesAtOrBelowTarget() public {
        _place(trader, BTC, 1_000e6, 1_000, false, 64_000e18, 0, 0, STOP);
        uint256 snap = vm.snapshotState();
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        _deliverAt(id, BTC, t, 64_000e18 + 1);
        assertEq(ts.openTradesCount(trader, BTC), 0, "one wei above: not hit");
        vm.revertToState(snap);
        (id, t) = _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        _deliverAt(id, BTC, t, 64_000e18);
        assertEq(ts.openTradesCount(trader, BTC), 1, "at target: hit");
    }

    function test_limitOpen_cancelsWhenTheFillWouldAlreadyHitTpOrSl() public {
        // STOP long 66,000 with TP 66,050: a 66,100 mid fills at 66,106.61 >= TP
        _place(trader, BTC, 1_000e6, 1_000, true, 66_000e18, 66_050e18, 0, STOP);
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationOpenOrderCanceled(id, trader, BTC, IOstiumTradingCallbacks.CancelReason.TP_REACHED);
        _deliverAt(id, BTC, t, 66_100e18);

        // LIMIT long ETH 2,490 with SL 2,489: a 2,488 mid fills at 2,488.2488 <= SL
        _place(trader, ETH, 1_000e6, 1_000, true, 2_490e18, 0, 2_489e18, LIMIT);
        (id, t) = _triggerNow(liquidatorA, trader, ETH, 0, OPEN);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationOpenOrderCanceled(id, trader, ETH, IOstiumTradingCallbacks.CancelReason.SL_REACHED);
        _deliverAt(id, ETH, t, 2_488e18);
        assertTrue(ts.hasOpenLimitOrder(trader, BTC, 0) && ts.hasOpenLimitOrder(trader, ETH, 0), "both rest");
    }

    function test_limitOpen_cancelsOnExposureLimitsAndKeepsTheOrder() public {
        _place(trader, WBT, 5_000e6, 2_500, true, 21e18, 0, 0, LIMIT);
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, WBT, 0, OPEN);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationOpenOrderCanceled(id, trader, WBT, IOstiumTradingCallbacks.CancelReason.EXPOSURE_LIMITS);
        _deliverAt(id, WBT, t, _basePrice(WBT));
        assertTrue(ts.hasOpenLimitOrder(trader, WBT, 0), "the trader can still cancel it");
    }

    function test_limitOpen_cancelsWhenCallbacksPausedOrMarketClosed() public {
        _place(trader, BTC, 1_000e6, 1_000, true, 64_000e18, 0, 0, LIMIT);
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationOpenOrderCanceled(id, trader, BTC, IOstiumTradingCallbacks.CancelReason.MARKET_CLOSED);
        _deliver(id, _closedReport(BTC, t));

        vm.prank(manager);
        callbacks.pause();
        (id, t) = _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationOpenOrderCanceled(id, trader, BTC, IOstiumTradingCallbacks.CancelReason.PAUSED);
        _deliverAt(id, BTC, t, 63_000e18);
        assertTrue(ts.hasOpenLimitOrder(trader, BTC, 0), "rests through both");
    }

    function test_updateLimit_rewritesTargetTpSlAndTouchesLastUpdated() public {
        _place(trader, BTC, 1_000e6, 1_000, true, 64_000e18, 0, 0, LIMIT);
        _advance(7);
        vm.expectEmit(true, true, true, true, d.trading);
        emit IOstiumTrading.OpenLimitUpdated(trader, BTC, 0, 63_000e18, 70_000e18, 60_000e18);
        vm.prank(trader);
        trading.updateOpenLimitOrder(BTC, 0, 63_000e18, 70_000e18, 60_000e18);
        IOstiumTradingStorage.OpenLimitOrder memory o = ts.getOpenLimitOrder(trader, BTC, 0);
        assertEq(o.targetPrice, 63_000e18, "target");
        assertEq(o.tp, 70_000e18, "tp");
        assertEq(o.sl, 60_000e18, "sl");
        assertEq(o.lastUpdated, vm.getBlockTimestamp(), "lastUpdated moved");
        assertEq(o.createdAt, vm.getBlockTimestamp() - 7, "createdAt kept");
    }

    function test_updateLimit_rejections() public {
        _place(trader, BTC, 1_000e6, 1_000, true, 64_000e18, 0, 0, LIMIT);
        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongParams.selector));
        trading.updateOpenLimitOrder(BTC, 0, 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NoLimitFound.selector, trader, BTC, uint8(1)));
        trading.updateOpenLimitOrder(BTC, 1, 64_000e18, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongTP.selector));
        trading.updateOpenLimitOrder(BTC, 0, 64_000e18, 64_000e18, 0);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongSL.selector));
        trading.updateOpenLimitOrder(BTC, 0, 64_000e18, 0, 64_000e18);
        vm.stopPrank();

        _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, BTC, uint8(0)));
        vm.prank(trader);
        trading.updateOpenLimitOrder(BTC, 0, 63_000e18, 0, 0);
        _advance(TRIGGER_TIMEOUT);
        vm.prank(trader);
        trading.updateOpenLimitOrder(BTC, 0, 63_000e18, 0, 0);
        assertEq(ts.getOpenLimitOrder(trader, BTC, 0).targetPrice, 63_000e18, "unlocked after triggerTimeout");
    }

    function test_cancelLimit_refundsMinusTheOracleFee() public {
        _place(trader, BTC, 1_000e6, 1_000, true, 64_000e18, 0, 0, LIMIT);
        uint256 before = _bal(trader);
        uint256 devBefore = ts.devFees();
        vm.expectEmit(true, true, true, true, d.trading);
        emit IOstiumTrading.OracleFeeChargedLimitCancelled(trader, BTC, ORACLE_FEE);
        vm.expectEmit(true, true, true, true, d.trading);
        emit IOstiumTrading.OpenLimitCanceled(trader, BTC, 0);
        vm.prank(trader);
        trading.cancelOpenLimitOrder(BTC, 0);
        assertEq(_bal(trader), before + 999e6, "refund");
        assertEq(ts.devFees(), devBefore + ORACLE_FEE, "fee");
        assertEq(_bal(d.tradingStorage), ts.devFees(), "only fees left in storage");
        assertFalse(ts.hasOpenLimitOrder(trader, BTC, 0), "gone");
        assertEq(ts.limitOrderIds(trader, BTC, 0), 0, "id cleared");

        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NoLimitFound.selector, trader, BTC, uint8(0)));
        vm.prank(trader);
        trading.cancelOpenLimitOrder(BTC, 0);
    }

    function test_cancelLimit_blockedWhileATriggerIsPending() public {
        _place(trader, BTC, 1_000e6, 1_000, true, 64_000e18, 0, 0, LIMIT);
        _triggerNow(liquidatorA, trader, BTC, 0, OPEN);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, BTC, uint8(0)));
        vm.prank(trader);
        trading.cancelOpenLimitOrder(BTC, 0);
    }

    // =====================================================================================
    // TP / SL through automation
    // =====================================================================================

    function _openWithTpSl(uint192 tp, uint192 sl) internal {
        _open(trader, BTC, 1_000e6, 1_000, true);
        vm.startPrank(trader);
        if (tp != 0) trading.updateTp(BTC, 0, tp);
        if (sl != 0) trading.updateSl(BTC, 0, sl);
        vm.stopPrank();
    }

    function test_tp_hitClosesAtThePostImpactPriceAndPaysFromTheVault() public {
        _openWithTpSl(66_000e18, 0);
        uint256 before = _bal(trader);
        uint256 vaultBefore = _bal(d.vault);
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, BTC, 0, TP);
        _deliverAt(id, BTC, t, 66_100e18);
        assertEq(ts.openTradesCount(trader, BTC), 0, "closed");
        uint256 paid = _bal(trader) - before;
        assertGt(paid, 993e6, "a winner");
        assertEq(_bal(d.vault), vaultBefore - (paid - 993e6), "the vault pays the profit");
        assertEq(_oi(BTC, true), 0, "OI released");
    }

    function test_tp_notHitOneTickShort() public {
        _openWithTpSl(66_000e18, 0);
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, BTC, 0, TP);
        uint256 tradeId = ts.getOpenTradeInfo(trader, BTC, 0).tradeId;
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationCloseOrderCanceled(
            id, tradeId, trader, BTC, TP, IOstiumTradingCallbacks.CancelReason.NOT_HIT
        );
        _deliverAt(id, BTC, t, 66_000e18); // bid 65,993.4 < TP
        assertEq(ts.getOpenTrade(trader, BTC, 0).collateral, 993e6, "untouched");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, TP), 0, "trigger cleared");
    }

    function test_sl_hitClosesOnTheMidAndTheVaultKeepsTheLoss() public {
        _openWithTpSl(0, 64_000e18);
        uint256 before = _bal(trader);
        uint256 vaultBefore = _bal(d.vault);
        (uint256 id, uint32 t) = _triggerNow(liquidatorB, trader, BTC, 0, SL);
        _deliverAt(id, BTC, t, 64_000e18); // mid exactly at SL
        assertEq(ts.openTradesCount(trader, BTC), 0, "closed at the SL");
        uint256 paid = _bal(trader) - before;
        assertLt(paid, 993e6, "a loser");
        assertEq(_bal(d.vault) - vaultBefore, 993e6 - paid, "the vault keeps the loss");
    }

    function test_sl_notHitOneWeiAbove() public {
        _openWithTpSl(0, 64_000e18);
        (uint256 id, uint32 t) = _triggerNow(liquidatorB, trader, BTC, 0, SL);
        _deliverAt(id, BTC, t, 64_000e18 + 1);
        assertEq(ts.openTradesCount(trader, BTC), 1, "survives");
    }

    function test_updateTp_boundsLongAndShort() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint192 o = ts.getOpenTrade(trader, BTC, 0).openPrice;
        uint192 maxTp = o + uint192(uint256(o) * 900 / 1_000);
        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongTP.selector));
        trading.updateTp(BTC, 0, maxTp + 1);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongTP.selector));
        trading.updateTp(BTC, 0, 0);
        uint256 tradeId = ts.getOpenTradeInfo(trader, BTC, 0).tradeId;
        vm.expectEmit(true, true, true, true, d.trading);
        emit IOstiumTrading.TpUpdated(tradeId, trader, BTC, 0, maxTp);
        trading.updateTp(BTC, 0, maxTp);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NoTradeFound.selector, trader, BTC, uint8(1)));
        trading.updateTp(BTC, 1, maxTp);
        vm.stopPrank();
        assertEq(ts.getOpenTrade(trader, BTC, 0).tp, maxTp, "exactly the max-gain price accepted");
        assertEq(ts.getOpenTradeInfo(trader, BTC, 0).tpLastUpdated, vm.getBlockTimestamp(), "timestamped");

        _open(other, ETH, 1_000e6, 1_000, false);
        uint192 os = ts.getOpenTrade(other, ETH, 0).openPrice;
        uint192 minTp = os - uint192(uint256(os) * 900 / 1_000);
        vm.startPrank(other);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongTP.selector));
        trading.updateTp(ETH, 0, minTp - 1);
        trading.updateTp(ETH, 0, minTp);
        vm.stopPrank();
        assertEq(ts.getOpenTrade(other, ETH, 0).tp, minTp, "short lower bound accepted");
    }

    function test_updateSl_boundsLongAndShortAndRemoval() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint192 o = ts.getOpenTrade(trader, BTC, 0).openPrice;
        uint192 minSl = o - uint192(uint256(o) * 85 / 1_000);
        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongSL.selector));
        trading.updateSl(BTC, 0, minSl - 1);
        trading.updateSl(BTC, 0, minSl);
        assertEq(ts.getOpenTrade(trader, BTC, 0).sl, minSl, "85% loss bound accepted");
        trading.updateSl(BTC, 0, 0);
        assertEq(ts.getOpenTrade(trader, BTC, 0).sl, 0, "zero removes the stop");
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NoTradeFound.selector, trader, BTC, uint8(3)));
        trading.updateSl(BTC, 3, minSl);
        vm.stopPrank();

        _open(other, ETH, 1_000e6, 1_000, false);
        uint192 os = ts.getOpenTrade(other, ETH, 0).openPrice;
        uint192 maxSl = os + uint192(uint256(os) * 85 / 1_000);
        vm.startPrank(other);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongSL.selector));
        trading.updateSl(ETH, 0, maxSl + 1);
        trading.updateSl(ETH, 0, maxSl);
        vm.stopPrank();
        assertEq(ts.getOpenTrade(other, ETH, 0).sl, maxSl, "short bound accepted");
    }

    function test_updateTpSl_blockedByAPendingTriggerOrClose() public {
        _openWithTpSl(66_000e18, 64_000e18);
        _triggerNow(liquidatorA, trader, BTC, 0, TP);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, BTC, uint8(0)));
        vm.prank(trader);
        trading.updateTp(BTC, 0, 67_000e18);
        // a pending TP does not lock the SL
        vm.prank(trader);
        trading.updateSl(BTC, 0, 63_000e18);

        _advance(TRIGGER_TIMEOUT);
        _requestClose(trader, BTC, 0, 0, _upx(BTC), 100);
        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, BTC, uint8(0)));
        trading.updateTp(BTC, 0, 67_000e18);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, BTC, uint8(0)));
        trading.updateSl(BTC, 0, 63_500e18);
        vm.stopPrank();
    }

    // =====================================================================================
    // topUpCollateral
    // =====================================================================================

    function test_topUp_exactHalvingOfLeverage() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 before = _bal(trader);
        uint256 tradeId = ts.getOpenTradeInfo(trader, BTC, 0).tradeId;
        vm.expectEmit(true, true, true, true, d.trading);
        emit IOstiumTrading.TopUpCollateralExecuted(tradeId, trader, BTC, 993e6, 500);
        vm.prank(trader);
        trading.topUpCollateral(BTC, 0, 993e6);
        IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, BTC, 0);
        assertEq(tr.collateral, 1_986e6, "collateral doubled");
        assertEq(tr.leverage, 500, "leverage halved");
        assertEq(_bal(trader), before - 993e6, "charged exactly");
        assertEq(ps.groupCollateral(BTC, true), 1_986e6, "group collateral");
        assertEq(ts.getOpenTradeInfo(trader, BTC, 0).initialLeverage, 1_000, "initial leverage kept");
    }

    /// @notice A top-up that does not land on a whole leverage step is rounded to the next
    ///         higher step and the trader is charged only what that step needs.
    function test_topUp_roundsToTheNextLeverageStepAndChargesLess() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 before = _bal(trader);
        vm.prank(trader);
        trading.topUpCollateral(BTC, 0, 1_000e6);
        IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, BTC, 0);
        uint256 expected = uint256(9_930e6) * 100 / 499;
        assertEq(tr.leverage, 499, "rounded up from 498.24");
        assertEq(tr.collateral, expected, "collateral sized for 4.99x");
        assertEq(before - _bal(trader), expected - 993e6, "charged less than asked");
    }

    function test_topUp_rejections() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NoTradeFound.selector, trader, BTC, uint8(1)));
        trading.topUpCollateral(BTC, 1, 100e6);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongParams.selector));
        trading.topUpCollateral(BTC, 0, 0);
        // group collateral would exceed 20% of the vault
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.ExposureLimits.selector));
        trading.topUpCollateral(BTC, 0, 20_000e6);
        vm.stopPrank();

        vm.prank(gov);
        trading.setMaxAllowedCollateral(1_500e6);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.AboveMaxAllowedCollateral.selector));
        vm.prank(trader);
        trading.topUpCollateral(BTC, 0, 993e6);

        _requestClose(trader, BTC, 0, 0, _upx(BTC), 100);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, BTC, uint8(0)));
        vm.prank(trader);
        trading.topUpCollateral(BTC, 0, 100e6);
    }

    function test_topUp_cannotTakeLeverageBelowTheMinimum() public {
        _open(trader, BTC, 1_000e6, 200, true); // 997.8 USDW at 2x after fees
        IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, BTC, 0);
        assertEq(tr.collateral, 997.8e6, "fees at 2x");
        // 1995.6 notional over 2997.8 is 0.6657x -> rounded up to 0.67x, still below 1x
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongLeverage.selector, uint32(67)));
        vm.prank(trader);
        trading.topUpCollateral(BTC, 0, 2_000e6);
    }

    // =====================================================================================
    // removeCollateral
    // =====================================================================================

    function test_removeCollateral_executedPaysOutAndRaisesLeverage() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 before = _bal(trader);
        uint256 devBefore = ts.devFees();
        (uint256 id, uint32 t) = _requestRemove(trader, BTC, 0, 496.5e6);
        assertEq(_bal(trader), before - ORACLE_FEE, "oracle fee paid up front from the wallet");
        assertEq(ts.devFees(), devBefore + ORACLE_FEE, "to dev fees");
        assertEq(ts.getPendingRemoveCollateral(id).removeAmount, 496.5e6, "request stored");
        assertGt(ts.orderTriggerBlock(trader, BTC, 0, IOstiumTradingStorage.LimitOrder.REMOVE_COLLATERAL), 0, "locked");

        _deliverAt(id, BTC, t, _basePrice(BTC));
        IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, BTC, 0);
        assertEq(tr.collateral, 496.5e6, "half removed");
        assertEq(tr.leverage, 2_000, "notional fixed, leverage doubled");
        assertEq(_bal(trader), before - ORACLE_FEE + 496.5e6, "paid out");
        assertEq(ps.groupCollateral(BTC, true), 496.5e6, "group collateral");
        assertEq(ts.getOpenTradeInfo(trader, BTC, 0).initialLeverage, 2_000, "initial leverage raised");
        assertEq(ts.getPendingRemoveCollateral(id).trader, address(0), "request cleared");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, IOstiumTradingStorage.LimitOrder.REMOVE_COLLATERAL), 0, "unlocked");
    }

    function test_removeCollateral_roundsTheAmountToAWholeLeverageStep() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        (uint256 id,) = _requestRemove(trader, BTC, 0, 400e6);
        assertEq(ts.getPendingRemoveCollateral(id).removeAmount, 993e6 - uint256(9_930e6) * 100 / 1_674, "rounded down to 16.74x");
    }

    function _assertRemoveRejected(uint256 id, IOstiumTradingCallbacks.CancelReason reason, bytes memory report) internal {
        uint256 before = _bal(trader);
        uint256 tradeId = ts.getOpenTradeInfo(trader, BTC, 0).tradeId;
        uint256 amount = ts.getPendingRemoveCollateral(id).removeAmount;
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.RemoveCollateralRejected(id, tradeId, trader, BTC, amount, reason);
        _deliver(id, report);
        assertEq(_bal(trader), before, "nothing paid");
        assertEq(ts.getOpenTrade(trader, BTC, 0).collateral, 993e6, "position untouched");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, IOstiumTradingStorage.LimitOrder.REMOVE_COLLATERAL), 0, "unlocked");
    }

    function test_removeCollateral_rejectedUnderLiquidation() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        (uint256 id, uint32 t) = _requestRemove(trader, BTC, 0, 993e6 - 99.3e6); // to 100x
        _assertRemoveRejected(id, IOstiumTradingCallbacks.CancelReason.UNDER_LIQUIDATION, _report(BTC, t, _px(BTC, -100)));
    }

    function test_removeCollateral_rejectedMarketClosedPausedAndMaxLeverage() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        (uint256 id, uint32 t) = _requestRemove(trader, BTC, 0, 496.5e6);
        _assertRemoveRejected(id, IOstiumTradingCallbacks.CancelReason.MARKET_CLOSED, _closedReport(BTC, t));

        (id, t) = _requestRemove(trader, BTC, 0, 496.5e6);
        vm.prank(gov);
        ps.setPairMaxLeverage(BTC, 1_500);
        _assertRemoveRejected(id, IOstiumTradingCallbacks.CancelReason.MAX_LEVERAGE, _report(BTC, t, _basePrice(BTC)));
        vm.prank(gov);
        ps.setPairMaxLeverage(BTC, 10_000);

        (id, t) = _requestRemove(trader, BTC, 0, 496.5e6);
        vm.prank(manager);
        callbacks.pause();
        _assertRemoveRejected(id, IOstiumTradingCallbacks.CancelReason.PAUSED, _report(BTC, t, _basePrice(BTC)));
    }

    function test_removeCollateral_requestRejections() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NoTradeFound.selector, trader, BTC, uint8(1)));
        trading.removeCollateral(BTC, 1, 1e6);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongParams.selector));
        trading.removeCollateral(BTC, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongParams.selector));
        trading.removeCollateral(BTC, 0, 993e6);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WrongLeverage.selector, uint32(331_000)));
        trading.removeCollateral(BTC, 0, 990e6);
        vm.stopPrank();

        _requestRemove(trader, BTC, 0, 100e6);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, BTC, uint8(0)));
        vm.prank(trader);
        trading.removeCollateral(BTC, 0, 100e6);
    }

    // =====================================================================================
    // pause / done
    // =====================================================================================

    function test_pause_blocksNewExposureButNotExits() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NotManager.selector, gov));
        vm.prank(gov);
        trading.pause();

        vm.expectEmit(true, true, true, true, d.trading);
        emit IOstiumTrading.Paused(true);
        vm.prank(manager);
        trading.pause();
        assertTrue(trading.isPaused(), "paused");

        _openReverts(_trade(trader, ETH, 100e6, 1_000, true, 0), MARKET, 100, abi.encodeWithSelector(IOstiumTrading.IsPaused.selector));
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.IsPaused.selector));
        vm.prank(trader);
        trading.removeCollateral(BTC, 0, 100e6);

        // exits and risk reduction keep working
        vm.startPrank(trader);
        trading.updateSl(BTC, 0, 64_000e18);
        trading.topUpCollateral(BTC, 0, 993e6);
        vm.stopPrank();
        assertEq(ts.getOpenTrade(trader, BTC, 0).leverage, 500, "top-up while paused");
        _closeAt(trader, BTC, 0, 0, _basePrice(BTC));
        assertEq(ts.openTradesCount(trader, BTC), 0, "close while paused");

        vm.prank(manager);
        trading.pause();
        assertFalse(trading.isPaused(), "toggled back");
        _open(trader, ETH, 100e6, 1_000, true);
        assertEq(ts.openTradesCount(trader, ETH), 1, "opens again");
    }

    function test_done_freezesEveryTraderEntryPoint() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        _place(trader, ETH, 100e6, 1_000, true, 2_400e18, 0, 0, LIMIT);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NotGov.selector, manager));
        vm.prank(manager);
        trading.done();
        vm.prank(gov);
        trading.done();
        assertTrue(trading.isDone(), "done");

        bytes memory isDone = abi.encodeWithSelector(IOstiumTrading.IsDone.selector);
        _openReverts(_trade(trader, SOL, 100e6, 1_000, true, 0), MARKET, 100, isDone);
        vm.startPrank(trader);
        vm.expectRevert(isDone);
        trading.closeTradeMarket(BTC, 0, 0, _upx(BTC), 100);
        vm.expectRevert(isDone);
        trading.updateTp(BTC, 0, 66_000e18);
        vm.expectRevert(isDone);
        trading.updateSl(BTC, 0, 64_000e18);
        vm.expectRevert(isDone);
        trading.topUpCollateral(BTC, 0, 1e6);
        vm.expectRevert(isDone);
        trading.removeCollateral(BTC, 0, 1e6);
        vm.expectRevert(isDone);
        trading.cancelOpenLimitOrder(ETH, 0);
        vm.expectRevert(isDone);
        trading.updateOpenLimitOrder(ETH, 0, 2_300e18, 0, 0);
        vm.expectRevert(isDone);
        trading.openTradeMarketTimeout(1);
        vm.expectRevert(isDone);
        trading.closeTradeMarketTimeout(1, false);
        vm.stopPrank();

        vm.prank(gov);
        trading.done();
        _closeAt(trader, BTC, 0, 0, _basePrice(BTC));
        assertEq(ts.openTradesCount(trader, BTC), 0, "live again");
    }

    // =====================================================================================
    // Max trades per pair
    // =====================================================================================

    function test_maxTradesPerPair_countsOpenPendingAndLimitOrders() public {
        assertEq(ts.maxTradesPerPair(), 10, "deployed cap");
        for (uint256 i = 0; i < 9; i++) {
            _open(trader, BTC, 100e6, 200, true);
        }
        _place(trader, BTC, 100e6, 200, true, 60_000e18, 0, 0, LIMIT);
        assertEq(ts.openTradesCount(trader, BTC), 9, "nine open");
        bytes memory full = abi.encodeWithSelector(IOstiumTrading.MaxTradesPerPairReached.selector, trader, BTC);
        _openReverts(_trade(trader, BTC, 100e6, 200, true, 0), MARKET, 100, full);
        _openReverts(_trade(trader, BTC, 100e6, 200, true, 0), LIMIT, 0, full);

        // other pairs and other traders are unaffected
        _open(trader, ETH, 100e6, 200, true);
        _open(other, BTC, 100e6, 200, true);

        // a closed slot is reused by the next open
        _closeAt(trader, BTC, 4, 0, _basePrice(BTC));
        (uint256 id, uint32 t) = _requestOpen(_trade(trader, BTC, 100e6, 200, true, 0), 100);
        _openReverts(_trade(trader, BTC, 100e6, 200, true, 0), MARKET, 100, full); // pending counts too
        _deliverAt(id, BTC, t, _basePrice(BTC));
        assertEq(ts.getOpenTrade(trader, BTC, 4).leverage, 200, "slot 4 reused");
    }

    // =====================================================================================
    // Per-market isolation
    // =====================================================================================

    function test_isolation_eachMarketKeepsItsOwnOiPricesAndBaseline() public {
        uint32[4] memory lev = [uint32(1_000), 500, 300, 200];
        for (uint16 p = 0; p < 4; p++) {
            _open(trader, p, 1_000e6, lev[p], p % 2 == 0);
        }
        for (uint16 p = 0; p < 4; p++) {
            IOstiumTradingStorage.Trade memory tr = ts.getOpenTrade(trader, p, 0);
            assertEq(tr.openPrice, _spreadFill(_basePrice(p), p % 2 == 0, true), "own price");
            assertEq(_oi(p, p % 2 == 0), uint256(tr.collateral) * 1e12 * lev[p] / 100 * 1e18 / tr.openPrice, "own OI");
            assertEq(_oi(p, p % 2 != 0), 0, "other side empty");
            assertEq(WhitespacePriceUpKeep(address(upkeep)).lastPrice(_feedOf(p)), _basePrice(p), "own baseline");
        }

        // BTC moves 4% and closes; the other three are untouched
        _closeAt(trader, BTC, 0, 0, _px(BTC, -400));
        assertEq(ts.openTradesCount(trader, BTC), 0, "BTC closed");
        for (uint16 p = 1; p < 4; p++) {
            assertEq(ts.getOpenTrade(trader, p, 0).leverage, lev[p], "others intact");
            assertEq(WhitespacePriceUpKeep(address(upkeep)).lastPrice(_feedOf(p)), _basePrice(p), "others' baselines");
        }

        // an ETH report cannot fill a SOL order
        (uint256 id, uint32 t) = _requestOpen(_trade(other, SOL, 100e6, 1_000, true, 0), 100);
        vm.expectRevert(abi.encodeWithSelector(IOstiumPriceUpKeep.InvalidPrice.selector, id));
        _deliver(id, _report(ETH, t, _basePrice(SOL)));

        // halting one feed stops only that market
        vm.prank(guardian);
        upkeep.haltFeed(_feedOf(SOL));
        vm.expectRevert(abi.encodeWithSelector(WhitespacePriceUpKeep.FeedHalted.selector, _feedOf(SOL)));
        vm.prank(other);
        trading.openTrade(_trade(other, SOL, 100e6, 1_000, true, 0), _noBuilder(), MARKET, 100);
        _open(other, ETH, 100e6, 1_000, true);
        assertEq(ts.openTradesCount(other, ETH), 1, "ETH still trades");
    }

    /// @notice Design note, not a defect: all four markets share one collateral group, so
    ///         collateral on BTC consumes the per-side capacity ETH/SOL/WBT can use.
    function test_isolation_groupCollateralIsSharedAcrossMarkets() public {
        _open(trader, BTC, 20_000e6, 200, true);
        assertEq(ps.groupCollateral(ETH, true), ps.groupCollateral(BTC, true), "one bucket");
        (uint256 id, uint32 t) = _requestOpen(_trade(other, ETH, 100e6, 1_000, true, 0), 100);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.MarketOpenCanceled(id, other, ETH, IOstiumTradingCallbacks.CancelReason.EXPOSURE_LIMITS);
        _deliverAt(id, ETH, t, _basePrice(ETH));
        // the other side of the book has its own bucket
        _open(other, ETH, 100e6, 1_000, false);
        assertEq(ts.openTradesCount(other, ETH), 1, "short side free");
    }
}
