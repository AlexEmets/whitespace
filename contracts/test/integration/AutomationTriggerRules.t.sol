// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {SystemFixture} from "../helpers/SystemFixture.sol";
import {ReportLib} from "../helpers/ReportLib.sol";
import {OstiumTradesUpKeep} from "../../src/vendor/ostium/OstiumTradesUpKeep.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumAutomationCompatible} from
    "../../src/vendor/ostium/interfaces/IOstiumAutomationCompatible.sol";

/// @notice Pins the trigger rules services/liquidator/src/triggerRules.mjs mirrors: for each
///         automation kind, WHICH of the report's three prices (price = mark, bid, ask) the
///         callback compares. Each test delivers a report where the mark and the bid/ask sit
///         on opposite sides of the trigger, so exactly one reading of the rule can pass.
///
/// @dev    Pair 0 has priceImpactK == 0 in this fixture, so the fill price after impact is
///         literally the bid (closing a long / opening a short) or the ask (the other two) —
///         TradingCallbacksLib._getTradePriceImpact.
contract AutomationTriggerRulesTest is SystemFixture {
    address internal trader = address(0x7AA);
    address internal bot = address(0xB07);
    OstiumTradesUpKeep internal tradesUpKeep;

    function setUp() public {
        _deployConfiguredSystem();
        _fundTrader(trader, 10_000e6);
        _deployAndRegisterTradesUpKeep();
    }

    // ------------------------------------------------------------------------- TP / SL

    /// TP on a long: hit <=> fill (= bid) >= tp. The mark does not matter.
    function test_tpOnALongComparesTheBidNotTheMark() public {
        _openPositionAtBaseline(trader, 1_000e6);
        vm.prank(trader);
        IOstiumTrading(d.trading).updateTp(0, 0, 66_000e18);

        // Mark above TP, bid below it: NOT_HIT, position stays open.
        _triggerAndDeliver(IOstiumTradingStorage.LimitOrder.TP, 0, 66_100e18, 65_999e18, 66_200e18);
        assertGt(_collateralOf(trader, 0), 0, "mark >= tp must not fire a long TP");

        // Mark below TP, bid exactly at it: fires.
        _triggerAndDeliver(IOstiumTradingStorage.LimitOrder.TP, 0, 65_900e18, 66_000e18, 66_100e18);
        assertEq(_collateralOf(trader, 0), 0, "bid == tp must fire a long TP");
    }

    /// SL on a long: hit <=> mark <= sl. The bid does not matter.
    function test_slOnALongComparesTheMarkNotTheBid() public {
        _openPositionAtBaseline(trader, 1_000e6);
        vm.prank(trader);
        IOstiumTrading(d.trading).updateSl(0, 0, 64_000e18);

        // Bid below SL, mark above it: NOT_HIT.
        _triggerAndDeliver(IOstiumTradingStorage.LimitOrder.SL, 0, 64_001e18, 63_000e18, 64_100e18);
        assertGt(_collateralOf(trader, 0), 0, "bid <= sl must not fire a long SL");

        // Mark exactly at SL, bid/ask above it: fires.
        _triggerAndDeliver(IOstiumTradingStorage.LimitOrder.SL, 0, 64_000e18, 64_500e18, 64_600e18);
        assertEq(_collateralOf(trader, 0), 0, "mark == sl must fire a long SL");
    }

    // ------------------------------------------------------------------------- entries

    /// LIMIT buy: hit <=> fill (= ask) <= target. The mark does not matter.
    function test_limitBuyComparesTheAskNotTheMark() public {
        _placeEntry(IOstiumTradingStorage.OpenOrderType.LIMIT, true, 64_500e18);

        // Mark below target, ask above it: NOT_HIT, order stays resting.
        _triggerAndDeliver(IOstiumTradingStorage.LimitOrder.OPEN, 0, 64_000e18, 63_900e18, 64_501e18);
        assertTrue(_hasLimit(0), "mark <= target must not fill a LIMIT buy");

        // Mark above target, ask exactly at it: fills.
        _triggerAndDeliver(IOstiumTradingStorage.LimitOrder.OPEN, 0, 64_600e18, 64_400e18, 64_500e18);
        assertFalse(_hasLimit(0), "ask == target must fill a LIMIT buy");
        assertGt(_collateralOf(trader, 0), 0, "the entry became a position");
    }

    /// STOP buy: hit <=> mark >= target. The ask does not matter.
    function test_stopBuyComparesTheMarkNotTheAsk() public {
        _placeEntry(IOstiumTradingStorage.OpenOrderType.STOP, true, 65_500e18);

        // Ask above target, mark below it: NOT_HIT.
        _triggerAndDeliver(IOstiumTradingStorage.LimitOrder.OPEN, 0, 65_499e18, 65_400e18, 65_600e18);
        assertTrue(_hasLimit(0), "ask >= target must not fill a STOP buy");

        // Mark exactly at target: fills.
        _triggerAndDeliver(IOstiumTradingStorage.LimitOrder.OPEN, 0, 65_500e18, 65_400e18, 65_450e18);
        assertFalse(_hasLimit(0), "mark == target must fill a STOP buy");
    }

    // ------------------------------------------------------------------------- helpers

    function _placeEntry(IOstiumTradingStorage.OpenOrderType orderType, bool buy, uint192 target) internal {
        vm.prank(trader);
        IOstiumTrading(d.trading).openTrade(
            IOstiumTradingStorage.Trade({
                collateral: 1_000e6,
                openPrice: target,
                tp: 0,
                sl: 0,
                trader: trader,
                leverage: 1000,
                pairIndex: 0,
                index: 0,
                buy: buy,
                isDayTrade: false
            }),
            IOstiumTradingStorage.BuilderFee({builder: address(0), builderFee: 0}),
            orderType,
            0
        );
        assertTrue(_hasLimit(0), "entry placed");
    }

    function _hasLimit(uint8 index) internal view returns (bool) {
        return IOstiumTradingStorage(d.tradingStorage).hasOpenLimitOrder(trader, 0, index);
    }

    function _triggerAndDeliver(
        IOstiumTradingStorage.LimitOrder kind,
        uint8 index,
        int192 price,
        int192 bid,
        int192 ask
    ) internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
        vm.recordLogs();
        vm.prank(bot);
        tradesUpKeep.performUpkeep(_payload(kind, index, block.timestamp));
        (uint256 orderId, uint32 ts) = _lastPriceRequest();

        ReportLib.Report memory r = ReportLib.btcReport(address(verifier), FEED, ts, price);
        r.bid = bid;
        r.ask = ask;
        _deliver(orderId, ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3)));
    }

    function _payload(IOstiumTradingStorage.LimitOrder kind, uint8 index, uint256 timestamp)
        internal
        view
        returns (bytes memory)
    {
        IOstiumAutomationCompatible.SimplifiedTradeId[] memory trades =
            new IOstiumAutomationCompatible.SimplifiedTradeId[](1);
        trades[0] = IOstiumAutomationCompatible.SimplifiedTradeId({
            trader: trader, pairId: 0, index: index, limitOrder: kind
        });
        return abi.encode(trades, timestamp);
    }

    /// Same shape as Liquidation.t.sol: behind an ERC1967Proxy, registered by gov, forwarder
    /// registered by the registry owner (onlyTimelock).
    function _deployAndRegisterTradesUpKeep() internal {
        tradesUpKeep = OstiumTradesUpKeep(
            address(
                new ERC1967Proxy(
                    address(new OstiumTradesUpKeep()),
                    abi.encodeCall(OstiumTradesUpKeep.initialize, (IOstiumRegistry(d.registry)))
                )
            )
        );
        bytes32[] memory names = new bytes32[](1);
        address[] memory addrs = new address[](1);
        names[0] = "tradesUpKeep";
        addrs[0] = address(tradesUpKeep);
        vm.prank(gov);
        IOstiumRegistry(d.registry).registerContracts(names, addrs);
        vm.prank(address(this));
        tradesUpKeep.registerForwarder(bot);
    }
}
