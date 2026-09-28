// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Test.sol";

import {TestnetTrading} from "../helpers/TestnetTrading.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumTradingCallbacks} from "../../src/vendor/ostium/interfaces/IOstiumTradingCallbacks.sol";
import {IOstiumTradesUpKeep} from "../../src/vendor/ostium/interfaces/IOstiumTradesUpKeep.sol";
import {IOstiumForwarded} from "../../src/vendor/ostium/interfaces/IOstiumForwarded.sol";
import {IOstiumAutomationCompatible} from "../../src/vendor/ostium/interfaces/IOstiumAutomationCompatible.sol";

/// @notice `OstiumTradesUpKeep` + `OstiumTrading.executeAutomationOrder` on the testnet
///         deployment: the forwarder allowlist, every `AutomationOrderStatus` the code can
///         return, batches with mixed outcomes, and the entries that revert a whole batch.
contract TradesUpKeepTest is TestnetTrading {
    address internal trader = address(0x7AA);

    IOstiumTradingStorage.LimitOrder internal constant TP = IOstiumTradingStorage.LimitOrder.TP;
    IOstiumTradingStorage.LimitOrder internal constant SL = IOstiumTradingStorage.LimitOrder.SL;
    IOstiumTradingStorage.LimitOrder internal constant LIQ = IOstiumTradingStorage.LimitOrder.LIQ;
    IOstiumTradingStorage.LimitOrder internal constant OPEN = IOstiumTradingStorage.LimitOrder.OPEN;

    uint8 internal constant S_PENDING_TRIGGER = uint8(IOstiumTrading.AutomationOrderStatus.PENDING_TRIGGER);
    uint8 internal constant S_NO_LIMIT = uint8(IOstiumTrading.AutomationOrderStatus.NO_LIMIT);
    uint8 internal constant S_NO_TRADE = uint8(IOstiumTrading.AutomationOrderStatus.NO_TRADE);
    uint8 internal constant S_NO_SL = uint8(IOstiumTrading.AutomationOrderStatus.NO_SL);
    uint8 internal constant S_NO_TP = uint8(IOstiumTrading.AutomationOrderStatus.NO_TP);
    uint8 internal constant S_SUCCESS = uint8(IOstiumTrading.AutomationOrderStatus.SUCCESS);
    uint8 internal constant S_PAUSED = uint8(IOstiumTrading.AutomationOrderStatus.PAUSED);
    uint8 internal constant S_BACKDATED = uint8(IOstiumTrading.AutomationOrderStatus.BACKDATED_EXECUTION);

    function setUp() public {
        _setUpTestnet();
        _fundTrader(trader, 1_000_000e6);
    }

    /// @dev Writes one entry field by field (a struct literal here is too deep for the stack
    ///      once inlined into the batch builders).
    function _set(
        IOstiumAutomationCompatible.SimplifiedTradeId[] memory e,
        uint256 slot,
        address who,
        uint16 pairIndex,
        IOstiumTradingStorage.LimitOrder kind
    ) internal pure {
        e[slot].trader = who;
        e[slot].pairId = pairIndex;
        e[slot].index = 0;
        e[slot].limitOrder = kind;
    }

    function _batch(address forwarder, IOstiumAutomationCompatible.SimplifiedTradeId[] memory entries, uint256 priceTs)
        internal
        returns (Vm.Log[] memory)
    {
        vm.recordLogs();
        vm.prank(forwarder);
        tradesUpKeep.performUpkeep(abi.encode(entries, priceTs));
        return vm.getRecordedLogs();
    }

    function _single(IOstiumTradingStorage.LimitOrder kind, uint16 pairIndex, uint256 priceTs)
        internal
        returns (uint8 status, bool requested)
    {
        Vm.Log[] memory logs = _perform(liquidatorA, trader, pairIndex, 0, kind, priceTs);
        uint8[] memory s = _automationStatuses(logs);
        assertEq(s.length, 1, "one entry, one AutomationPerformed");
        return (s[0], _hasPriceRequest(logs));
    }

    // =====================================================================================
    // Forwarder allowlist
    // =====================================================================================

    function test_allowlist_onlyTheTimelockRegistersAndOnlyGovRemoves() public {
        address fwd = address(0xF0D);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTradesUpKeep.NotTimelock.selector, gov));
        vm.prank(gov);
        tradesUpKeep.registerForwarder(fwd);

        vm.expectEmit(true, true, true, true, address(tradesUpKeep));
        emit IOstiumForwarded.ForwarderAdded(fwd);
        vm.prank(owner);
        tradesUpKeep.registerForwarder(fwd);
        assertTrue(tradesUpKeep.isForwarder(fwd), "registered");

        vm.expectRevert(abi.encodeWithSelector(IOstiumForwarded.AlreadyForwarder.selector, fwd));
        vm.prank(owner);
        tradesUpKeep.registerForwarder(fwd);

        vm.expectRevert(abi.encodeWithSelector(IOstiumTradesUpKeep.NotGov.selector, owner));
        vm.prank(owner);
        tradesUpKeep.unregisterForwarder(fwd);

        vm.expectEmit(true, true, true, true, address(tradesUpKeep));
        emit IOstiumForwarded.ForwarderRemoved(fwd);
        vm.prank(gov);
        tradesUpKeep.unregisterForwarder(fwd);
        assertFalse(tradesUpKeep.isForwarder(fwd), "removed");

        vm.expectRevert(abi.encodeWithSelector(IOstiumForwarded.NotForwarder.selector, fwd));
        vm.prank(gov);
        tradesUpKeep.unregisterForwarder(fwd);
    }

    function test_allowlist_batchRegisterAndRemove() public {
        address[] memory fwds = new address[](2);
        fwds[0] = address(0xF01);
        fwds[1] = address(0xF02);
        vm.prank(owner);
        tradesUpKeep.registerForwarders(fwds);
        assertTrue(tradesUpKeep.isForwarder(fwds[0]) && tradesUpKeep.isForwarder(fwds[1]), "both");
        vm.prank(gov);
        tradesUpKeep.unregisterForwarders(fwds);
        assertFalse(tradesUpKeep.isForwarder(fwds[0]) || tradesUpKeep.isForwarder(fwds[1]), "neither");
    }

    function test_allowlist_nonForwardersAndRemovedForwardersAreRefused() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        address[3] memory outsiders = [keeper, trader, gov];
        bytes memory payload = _automationPayload(trader, BTC, 0, LIQ, vm.getBlockTimestamp());
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(IOstiumForwarded.NotForwarder.selector, outsiders[i]));
            vm.prank(outsiders[i]);
            tradesUpKeep.performUpkeep(payload);
        }
        vm.prank(gov);
        tradesUpKeep.unregisterForwarder(liquidatorB);
        vm.expectRevert(abi.encodeWithSelector(IOstiumForwarded.NotForwarder.selector, liquidatorB));
        vm.prank(liquidatorB);
        tradesUpKeep.performUpkeep(payload);
        // A is unaffected
        (uint8 s,) = _single(LIQ, BTC, vm.getBlockTimestamp());
        assertEq(s, S_SUCCESS, "liquidator A still triggers");
    }

    function test_executeAutomationOrder_onlyFromTheTradesUpKeep() public {
        uint256 now_ = vm.getBlockTimestamp();
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.NotTradesUpKeep.selector, liquidatorA));
        vm.prank(liquidatorA);
        trading.executeAutomationOrder(LIQ, trader, BTC, 0, now_);
    }

    // =====================================================================================
    // Every status
    // =====================================================================================

    function test_status_successRequestsAPriceAndSetsTheTrigger() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        (uint8 s, bool req) = _single(TP, BTC, vm.getBlockTimestamp());
        assertEq(s, S_SUCCESS, "SUCCESS");
        assertTrue(req, "price requested");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, TP), vm.getBlockNumber(), "trigger stamped");
    }

    function test_status_pendingTriggerUntilTriggerTimeoutElapses() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        _single(LIQ, BTC, vm.getBlockTimestamp());
        uint256 stamped = ts.orderTriggerBlock(trader, BTC, 0, LIQ);

        _advance(TRIGGER_TIMEOUT - 1);
        (uint8 s, bool req) = _single(LIQ, BTC, vm.getBlockTimestamp());
        assertEq(s, S_PENDING_TRIGGER, "PENDING_TRIGGER at +29");
        assertFalse(req, "no request");
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, LIQ), stamped, "not re-stamped");

        _advance(1);
        (s, req) = _single(LIQ, BTC, vm.getBlockTimestamp());
        assertEq(s, S_SUCCESS, "SUCCESS again at +30");
        assertTrue(req, "requested");
    }

    function test_status_noLimit() public {
        (uint8 s, bool req) = _single(OPEN, BTC, vm.getBlockTimestamp());
        assertEq(s, S_NO_LIMIT, "NO_LIMIT");
        assertFalse(req, "no request");
    }

    function test_status_noTrade() public {
        (uint8 s, bool req) = _single(TP, BTC, vm.getBlockTimestamp());
        assertEq(s, S_NO_TRADE, "NO_TRADE");
        assertFalse(req, "no request");
        (s,) = _single(LIQ, ETH, vm.getBlockTimestamp());
        assertEq(s, S_NO_TRADE, "NO_TRADE for LIQ too");
    }

    function test_status_noSlWhenUnsetOrUpdatedAfterThePrice() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        (uint8 s,) = _single(SL, BTC, vm.getBlockTimestamp());
        assertEq(s, S_NO_SL, "no stop set");

        uint256 before = vm.getBlockTimestamp();
        _advance(5);
        vm.prank(trader);
        trading.updateSl(BTC, 0, 64_000e18);
        (s,) = _single(SL, BTC, before + 2);
        assertEq(s, S_NO_SL, "stop set after the price's timestamp");
        (s,) = _single(SL, BTC, vm.getBlockTimestamp());
        assertEq(s, S_SUCCESS, "a price at or after the update");
    }

    function test_status_noTpWhenUpdatedAfterThePrice() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 before = vm.getBlockTimestamp();
        _advance(5);
        vm.prank(trader);
        trading.updateTp(BTC, 0, 66_000e18);
        (uint8 s, bool req) = _single(TP, BTC, before + 2);
        assertEq(s, S_NO_TP, "NO_TP");
        assertFalse(req, "no request");
    }

    function test_status_pausedOnlyAffectsLimitOpens() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        _place(trader, ETH, 100e6, 1_000, true, 2_400e18, 0, 0, IOstiumTradingStorage.OpenOrderType.LIMIT);
        vm.prank(manager);
        trading.pause();
        (uint8 s, bool req) = _single(OPEN, ETH, vm.getBlockTimestamp());
        assertEq(s, S_PAUSED, "PAUSED");
        assertFalse(req, "no request");
        (s,) = _single(LIQ, BTC, vm.getBlockTimestamp());
        assertEq(s, S_SUCCESS, "liquidations still run while paused");
    }

    function test_status_backdatedForLimitsAndPositions() public {
        uint256 t0 = vm.getBlockTimestamp();
        _advance(5);
        _place(trader, ETH, 100e6, 1_000, true, 2_400e18, 0, 0, IOstiumTradingStorage.OpenOrderType.LIMIT);
        (uint8 s, bool req) = _single(OPEN, ETH, t0);
        assertEq(s, S_BACKDATED, "price older than the order");
        assertFalse(req, "no request");
        assertEq(ts.orderTriggerBlock(trader, ETH, 0, OPEN), 0, "no trigger");

        _open(trader, BTC, 1_000e6, 1_000, true);
        (s,) = _single(LIQ, BTC, vm.getBlockTimestamp() - 1);
        assertEq(s, S_BACKDATED, "price older than the trade");
        (s,) = _single(LIQ, BTC, vm.getBlockTimestamp());
        assertEq(s, S_SUCCESS, "same second is fine");
    }

    /// @notice CLOSE_DAY_TRADE is accepted by the upkeep but can never close anything on
    ///         testnet: no pair has an overnight leverage, so no trade is a day trade.
    function test_closeDayTrade_isRequestedThenCancelled() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 tradeId = ts.getOpenTradeInfo(trader, BTC, 0).tradeId;
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, trader, BTC, 0, IOstiumTradingStorage.LimitOrder.CLOSE_DAY_TRADE);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationCloseOrderCanceled(
            id,
            tradeId,
            trader,
            BTC,
            IOstiumTradingStorage.LimitOrder.CLOSE_DAY_TRADE,
            IOstiumTradingCallbacks.CancelReason.CLOSE_DAY_TRADE_NOT_ALLOWED
        );
        _deliverAt(id, BTC, t, _basePrice(BTC));
        assertEq(ts.openTradesCount(trader, BTC), 1, "still open");
    }

    // =====================================================================================
    // Batches
    // =====================================================================================

    function test_batch_mixedStatusesAreEachReportedAndOnlySuccessRequests() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        IOstiumAutomationCompatible.SimplifiedTradeId[] memory e = new IOstiumAutomationCompatible.SimplifiedTradeId[](5);
        _set(e, 0, trader, BTC, TP); // SUCCESS (the default max-gain TP)
        _set(e, 1, trader, ETH, LIQ); // NO_TRADE
        _set(e, 2, address(0), BTC, LIQ); // skipped: no event at all
        _set(e, 3, trader, BTC, SL); // NO_SL
        _set(e, 4, trader, BTC, TP); // PENDING_TRIGGER (set by e[0])
        Vm.Log[] memory logs = _batch(liquidatorB, e, vm.getBlockTimestamp());

        uint8[] memory s = _automationStatuses(logs);
        assertEq(s.length, 4, "the zero-trader entry is skipped");
        assertEq(s[0], S_SUCCESS, "e0");
        assertEq(s[1], S_NO_TRADE, "e1");
        assertEq(s[2], S_NO_SL, "e3");
        assertEq(s[3], S_PENDING_TRIGGER, "e4");

        uint256 requests;
        bytes32 sig = keccak256("PriceRequestedV2(uint256,uint8,bytes32,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 1 && logs[i].topics[0] == sig) requests++;
        }
        assertEq(requests, 1, "exactly one oracle request");
    }

    function _goodThenBad(IOstiumTradingStorage.LimitOrder kind, uint16 pairIndex) internal view returns (bytes memory) {
        IOstiumAutomationCompatible.SimplifiedTradeId[] memory e = new IOstiumAutomationCompatible.SimplifiedTradeId[](2);
        _set(e, 0, trader, BTC, LIQ); // would succeed on its own
        _set(e, 1, trader, pairIndex, kind);
        return abi.encode(e, vm.getBlockTimestamp());
    }

    function _assertBatchReverts(bytes memory payload, bytes memory err) internal {
        vm.expectRevert(err);
        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(payload);
        assertEq(ts.orderTriggerBlock(trader, BTC, 0, LIQ), 0, "the good entry was rolled back too");
    }

    /// @notice One malformed entry reverts the whole batch, including the valid entries
    ///         before it. Only allowlisted forwarders submit batches, so this is a liveness
    ///         hazard for a buggy keeper rather than a griefing vector.
    function test_batch_aSingleInvalidEntryRevertsTheWholeBatch() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        bytes memory wrong = abi.encodeWithSelector(IOstiumTrading.WrongParams.selector);
        _assertBatchReverts(_goodThenBad(IOstiumTradingStorage.LimitOrder.REMOVE_COLLATERAL, BTC), wrong);
        _assertBatchReverts(_goodThenBad(IOstiumTradingStorage.LimitOrder.PENDING_CLOSE, BTC), wrong);
        _assertBatchReverts(
            _goodThenBad(LIQ, 9), abi.encodeWithSelector(IOstiumTrading.PairNotListed.selector, uint16(9))
        );
    }

    function test_batch_revertsWhileTradingIsDone() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        vm.prank(gov);
        trading.done();
        bytes memory payload = _automationPayload(trader, BTC, 0, LIQ, vm.getBlockTimestamp());
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.IsDone.selector));
        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(payload);
    }

    function test_batch_emptyIsANoOp() public {
        IOstiumAutomationCompatible.SimplifiedTradeId[] memory e = new IOstiumAutomationCompatible.SimplifiedTradeId[](0);
        Vm.Log[] memory logs = _batch(liquidatorA, e, vm.getBlockTimestamp());
        assertEq(logs.length, 0, "nothing emitted");
    }
}
