// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TestnetFixture} from "./TestnetFixture.sol";
import {ReportLib} from "./ReportLib.sol";
import {OstiumTrading} from "../../src/vendor/ostium/OstiumTrading.sol";
import {OstiumTradingCallbacks} from "../../src/vendor/ostium/OstiumTradingCallbacks.sol";
import {OstiumPairInfos} from "../../src/vendor/ostium/OstiumPairInfos.sol";
import {OstiumVault} from "../../src/vendor/ostium/OstiumVault.sol";
import {OstiumOpenPnl} from "../../src/vendor/ostium/OstiumOpenPnl.sol";
import {IOstiumPairsStorage} from "../../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";

/// @notice Typed handles and request/deliver helpers on top of `TestnetFixture`, shared by the
///         Trading, Vault, PairInfos and TradesUpKeep suites and the invariant handler.
/// @dev    Every helper drives the system the way production does: a trader (or forwarder)
///         request, then a 3-of-5 signed report delivered by the keeper through the hardened
///         upkeep. Nothing here writes contract storage directly.
abstract contract TestnetTrading is TestnetFixture {
    OstiumTrading internal trading;
    OstiumTradingCallbacks internal callbacks;
    OstiumPairInfos internal pairInfos;
    OstiumVault internal vault;
    OstiumOpenPnl internal openPnl;
    IOstiumTradingStorage internal ts;
    IOstiumPairsStorage internal ps;
    IERC20 internal usdw;

    uint256 internal constant ORACLE_FEE = 1e6;
    uint32 internal constant TRIGGER_TIMEOUT = 30;
    uint16 internal constant MARKET_TIMEOUT = 11;

    function _setUpTestnet() internal {
        _deployTestnet();
        _bindTestnet();
    }

    /// @dev Binds the typed handles to an already-populated `d` (e.g. in an invariant handler
    ///      that is handed the deployment rather than deploying its own).
    function _bindTestnet() internal {
        trading = OstiumTrading(d.trading);
        callbacks = OstiumTradingCallbacks(d.callbacks);
        pairInfos = OstiumPairInfos(d.pairInfos);
        vault = OstiumVault(d.vault);
        openPnl = OstiumOpenPnl(d.openPnl);
        ts = IOstiumTradingStorage(d.tradingStorage);
        ps = IOstiumPairsStorage(d.pairsStorage);
        usdw = IERC20(d.collateral);
    }

    // -------------------------------------------------------------------------------------
    // Prices
    // -------------------------------------------------------------------------------------

    /// @dev The pair's base price moved by `bps` basis points (may be negative).
    function _px(uint16 pairIndex, int256 bps) internal pure returns (int192) {
        return int192(int256(_basePrice(pairIndex)) * (10_000 + bps) / 10_000);
    }

    function _upx(uint16 pairIndex) internal pure returns (uint192) {
        return uint192(uint256(int256(_basePrice(pairIndex))));
    }

    /// @notice The fixture's report (3-of-5, bid/ask one basis point either side), or with
    ///         `open == false` a closed-market report, whose price/bid/ask the upkeep zeroes.
    /// @dev    External, and called as `this.signedReportExt`, on purpose: the fixture's
    ///         `_report` builds a nine-field struct literal, and once the optimiser inlines that
    ///         into a caller holding a few locals the stack is too deep. An external self-call
    ///         is never inlined.
    function signedReportExt(uint16 pairIndex, uint32 timestamp, int192 price, bool open)
        external
        view
        returns (bytes memory)
    {
        ReportLib.Report memory r;
        r.chainId = block.chainid;
        r.verifier = address(verifier);
        r.feedId = _feedOf(pairIndex);
        r.timestamp = timestamp;
        r.price = price;
        int192 half = open ? price / 10_000 : int192(0);
        r.bid = price - half;
        r.ask = price + half;
        r.isMarketOpen = open;
        return ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3));
    }

    /// @dev A 3-of-5 report for a closed market: the upkeep zeroes price/bid/ask.
    function _closedReport(uint16 pairIndex, uint32 timestamp) internal view returns (bytes memory) {
        return this.signedReportExt(pairIndex, timestamp, _basePrice(pairIndex), false);
    }

    function _deliverAt(uint256 orderId, uint16 pairIndex, uint32 timestamp, int192 price) internal {
        _deliver(orderId, this.signedReportExt(pairIndex, timestamp, price, true));
    }

    // -------------------------------------------------------------------------------------
    // Trader actions
    // -------------------------------------------------------------------------------------

    function _tradeFull(
        address who,
        uint16 pairIndex,
        uint256 collateral,
        uint32 leverage,
        bool buy,
        uint192 openPrice,
        uint192 tp,
        uint192 sl
    ) internal pure returns (IOstiumTradingStorage.Trade memory t) {
        // Field by field, not a struct literal: a 10-field literal evaluates every field onto
        // the stack before allocating, which is too deep once this is inlined into a caller
        // that already holds a few locals.
        t.collateral = collateral;
        t.openPrice = openPrice;
        t.tp = tp;
        t.sl = sl;
        t.trader = who;
        t.leverage = leverage;
        t.pairIndex = pairIndex;
        t.buy = buy;
    }

    /// @notice Opens and fills a market position at `price`; returns its trade index.
    function _openAt(address who, uint16 pairIndex, uint256 collateral, uint32 leverage, bool buy, int192 price)
        internal
        returns (uint8 index)
    {
        index = ts.firstEmptyTradeIndex(who, pairIndex);
        uint32 countBefore = ts.openTradesCount(who, pairIndex);
        _fillAt(_tradeFull(who, pairIndex, collateral, leverage, buy, uint192(uint256(int256(price))), 0, 0), price);
        require(ts.openTradesCount(who, pairIndex) == countBefore + 1, "open did not fill");
    }

    /// @dev Kept separate from `_openAt` so neither function is too deep for the stack.
    function _fillAt(IOstiumTradingStorage.Trade memory t, int192 price) internal {
        (uint256 orderId, uint32 timestamp) = _requestOpen(t, 500);
        _deliverAt(orderId, t.pairIndex, timestamp, price);
    }

    /// @notice Places a LIMIT or STOP order; returns its limit index.
    function _place(
        address who,
        uint16 pairIndex,
        uint256 collateral,
        uint32 leverage,
        bool buy,
        uint192 target,
        uint192 tp,
        uint192 sl,
        IOstiumTradingStorage.OpenOrderType kind
    ) internal returns (uint8 index) {
        index = ts.firstEmptyOpenLimitIndex(who, pairIndex);
        _submit(_tradeFull(who, pairIndex, collateral, leverage, buy, target, tp, sl), kind);
    }

    function _submit(IOstiumTradingStorage.Trade memory t, IOstiumTradingStorage.OpenOrderType kind) internal {
        vm.prank(t.trader);
        trading.openTrade(t, _noBuilder(), kind, 0);
    }

    function _requestClose(address who, uint16 pairIndex, uint8 index, uint16 pct, uint192 wanted, uint32 slippageP)
        internal
        returns (uint256 orderId, uint32 timestamp)
    {
        vm.recordLogs();
        vm.prank(who);
        trading.closeTradeMarket(pairIndex, index, pct, wanted, slippageP);
        return _lastPriceRequest();
    }

    function _closeAt(address who, uint16 pairIndex, uint8 index, uint16 pct, int192 price) internal {
        (uint256 orderId, uint32 t) = _requestClose(who, pairIndex, index, pct, uint192(uint256(int256(price))), 500);
        _deliverAt(orderId, pairIndex, t, price);
    }

    function _requestRemove(address who, uint16 pairIndex, uint8 index, uint256 amount)
        internal
        returns (uint256 orderId, uint32 timestamp)
    {
        vm.recordLogs();
        vm.prank(who);
        trading.removeCollateral(pairIndex, index, amount);
        return _lastPriceRequest();
    }

    /// @notice A forwarder submits one automation entry with an explicit price timestamp;
    ///         returns every log the call emitted.
    function _perform(
        address forwarder,
        address who,
        uint16 pairIndex,
        uint8 index,
        IOstiumTradingStorage.LimitOrder kind,
        uint256 priceTimestamp
    ) internal returns (Vm.Log[] memory) {
        return _performPayload(forwarder, _automationPayload(who, pairIndex, index, kind, priceTimestamp));
    }

    /// @notice The fixture's `_trigger`, but stamped with `vm.getBlockTimestamp()`: under via-IR
    ///         the optimiser may reuse a `block.timestamp` read from before a `vm.warp` in the
    ///         same (inlined) function, which would backdate the automation request.
    function _triggerNow(
        address forwarder,
        address who,
        uint16 pairIndex,
        uint8 index,
        IOstiumTradingStorage.LimitOrder kind
    ) internal returns (uint256 orderId, uint32 timestamp) {
        bytes memory payload = _automationPayload(who, pairIndex, index, kind, vm.getBlockTimestamp());
        vm.recordLogs();
        vm.prank(forwarder);
        tradesUpKeep.performUpkeep(payload);
        return _lastPriceRequest();
    }

    function _performPayload(address forwarder, bytes memory payload) internal returns (Vm.Log[] memory) {
        vm.recordLogs();
        vm.prank(forwarder);
        tradesUpKeep.performUpkeep(payload);
        return vm.getRecordedLogs();
    }

    /// @notice The fill a spread-only (below the net-volume threshold) trade gets at `price`,
    ///         computed exactly as `TradingCallbacksLib.getDynamicTradePriceImpact` does for the
    ///         fixture's one-basis-point bid/ask.
    function _spreadFill(int192 price, bool buy, bool isOpen) internal pure returns (uint256) {
        int192 half = price / 10_000;
        uint256 p = uint256(int256(price));
        uint256 impactP = uint256(int256(2 * half)) * 1e18 * 100 / (p * 2);
        return isOpen == buy ? p * (1e18 + impactP / 100) / 1e18 : p * (1e18 - impactP / 100) / 1e18;
    }

    // -------------------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------------------

    function _bal(address who) internal view returns (uint256) {
        return usdw.balanceOf(who);
    }

    function _oi(uint16 pairIndex, bool long) internal view returns (uint256) {
        return ts.openInterest(pairIndex, long ? 0 : 1);
    }

    /// @dev The status every `AutomationPerformed` in the recorded logs carried, in order.
    function _automationStatuses(Vm.Log[] memory logs) internal pure returns (uint8[] memory out) {
        bytes32 sig = keccak256("AutomationPerformed(uint8,uint256,uint8,address)");
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 4 && logs[i].topics[0] == sig) n++;
        }
        out = new uint8[](n);
        n = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 4 && logs[i].topics[0] == sig) out[n++] = uint8(uint256(logs[i].topics[3]));
        }
    }

    /// @dev True if any recorded log is `PriceRequestedV2`.
    function _hasPriceRequest(Vm.Log[] memory logs) internal pure returns (bool) {
        bytes32 sig = keccak256("PriceRequestedV2(uint256,uint8,bytes32,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 1 && logs[i].topics[0] == sig) return true;
        }
        return false;
    }
}
