// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SystemFixture} from "../helpers/SystemFixture.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumPriceUpKeep} from "../../src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol";
import {WhitespacePriceUpKeep} from "../../src/oracle/WhitespacePriceUpKeep.sol";

/// @notice Design spec §8 adversarial scenario: **keeper censorship**. A keeper that simply never
///         delivers. Does the trader always recover collateral, and is there a window where the
///         order is neither fillable nor refundable?
///
/// @dev    Phase 2 flagged the shape of this (`docs/decisions/phase-2-oracle-hardening.md` §9) but
///         did not measure it. These tests measure it, at the exact boundary blocks, on the real
///         deployed contract set.
///
///         The two bounds are in DIFFERENT UNITS, which is the whole reason the gap exists:
///
///         | Bound | Value | Unit | Enforced by |
///         |---|---|---|---|
///         | `maxAge` | 10 | **seconds** | `WhitespacePriceUpKeep.performUpkeep` |
///         | `marketOrdersTimeout` | 30 | **blocks** | `OstiumTrading.openTradeMarketTimeout` |
///
///         Chain 1874 produces one block per second (design spec §2.1, measured), so the two are
///         comparable there and the gap is ~20 s. These tests model that 1 s/block relationship
///         explicitly via `_advance`, rather than warping time and block height independently,
///         because it is the chain fact that makes the numbers commensurable.
contract KeeperCensorshipTest is SystemFixture {
    address internal trader = address(0x7AA);

    uint256 internal constant COLLATERAL = 1_000e6; // 1,000 USDW, 6 decimals

    function setUp() public {
        _deployConfiguredSystem();
        _fundTrader(trader, 10_000e6);
    }

    /// @dev Chain 1874 is measured at exactly 1.00 s/block, so advancing n blocks advances n
    ///      seconds. Modelling them together is what makes "10 seconds" and "30 blocks"
    ///      comparable at all.
    function _advance(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + blocks);
    }

    // `_blockNow()` lives on `SystemFixture` — see the via_ir capture hazard documented there.

    // -------------------------------------------------------------------------------------
    // The window, measured
    // -------------------------------------------------------------------------------------

    /// @notice The last block at which a censored order can still be filled.
    function test_deliveryStillSucceedsAtTheMaxAgeBoundary() public {
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(trader, COLLATERAL, 1000, true);

        _advance(MAX_AGE); // block.timestamp == timestamp + 10, the boundary is inclusive
        _deliver(orderId, _signed(timestamp, BTC_65K));

        assertGt(_collateralOf(trader, 0), 0, "delivery at exactly maxAge must still open");
    }

    /// @notice One second later the order can never be filled — by ANY keeper, with a perfectly
    ///         valid k-of-3 report. The report timestamp is pinned to the order timestamp, so
    ///         re-signing at a fresher timestamp does not help; that is `InvalidPrice`.
    function test_orderIsUnfillableOneSecondPastMaxAge() public {
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(trader, COLLATERAL, 1000, true);

        _advance(MAX_AGE + 1);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespacePriceUpKeep.StaleReport.selector, timestamp, block.timestamp, MAX_AGE
            )
        );
        IOstiumPriceUpKeep(address(upkeep)).performUpkeep(
            abi.encode(_signed(timestamp, BTC_65K), orderId)
        );
    }

    /// @notice And a report re-signed at the CURRENT timestamp is rejected too — proving the
    ///         order is dead rather than merely needing a fresher report. This is the half that
    ///         turns "stale" into "unfillable forever".
    function test_reSigningAtAFreshTimestampDoesNotRescueTheOrder() public {
        (uint256 orderId,) = _openMarketTrade(trader, COLLATERAL, 1000, true);

        _advance(MAX_AGE + 1);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IOstiumPriceUpKeep.InvalidPrice.selector, orderId));
        IOstiumPriceUpKeep(address(upkeep)).performUpkeep(
            abi.encode(_signed(uint32(block.timestamp), BTC_65K), orderId)
        );
    }

    /// @notice The refund is not yet available at the last block of the dead window.
    function test_refundIsUnavailableThroughoutTheDeadWindow() public {
        uint256 openBlock = _blockNow();
        (uint256 orderId,) = _openMarketTrade(trader, COLLATERAL, 1000, true);

        // One block short of the timeout — the last block on which the trader is stuck.
        _advance(MARKET_ORDERS_TIMEOUT - 1);
        assertEq(_blockNow(), openBlock + MARKET_ORDERS_TIMEOUT - 1);

        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WaitTimeout.selector, orderId));
        IOstiumTrading(d.trading).openTradeMarketTimeout(orderId);
    }

    /// @notice **The measurement.** Between `maxAge` and `marketOrdersTimeout` the order is
    ///         neither fillable nor refundable. This test walks every block in that range and
    ///         asserts BOTH doors are shut at each one, then asserts the window's exact width.
    ///
    /// @dev    The trader's collateral sits in `tradingStorage` for the whole window. It is not
    ///         lost — `test_traderAlwaysRecoversCollateralAfterTheTimeout` proves recovery — but
    ///         a keeper can impose this delay on any order at will, for free, by doing nothing.
    function test_measureTheWindowWhereAnOrderIsNeitherFillableNorRefundable() public {
        uint256 openBlock = _blockNow();
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(trader, COLLATERAL, 1000, true);

        uint256 stuckBlocks;

        // The window runs from the first block past maxAge to the last block before the timeout.
        for (uint256 n = MAX_AGE + 1; n < MARKET_ORDERS_TIMEOUT; n++) {
            uint256 snapshot = vm.snapshotState();
            _advance(n);

            // Door 1: delivery. Shut — the signed report is past maxAge.
            vm.prank(keeper);
            vm.expectRevert(
                abi.encodeWithSelector(
                    WhitespacePriceUpKeep.StaleReport.selector, timestamp, block.timestamp, MAX_AGE
                )
            );
            IOstiumPriceUpKeep(address(upkeep)).performUpkeep(
                abi.encode(_signed(timestamp, BTC_65K), orderId)
            );

            // Door 2: refund. Shut — the block timeout has not elapsed.
            vm.prank(trader);
            vm.expectRevert(abi.encodeWithSelector(IOstiumTrading.WaitTimeout.selector, orderId));
            IOstiumTrading(d.trading).openTradeMarketTimeout(orderId);

            assertEq(_blockNow(), openBlock + n, "block accounting drifted");
            stuckBlocks++;
            vm.revertToState(snapshot);
        }

        // 30 - 10 - 1 = 19 blocks: n = 11 .. 29 inclusive.
        assertEq(stuckBlocks, 19, "the dead window is 19 blocks wide at 1 s/block");
        assertEq(
            stuckBlocks,
            MARKET_ORDERS_TIMEOUT - MAX_AGE - 1,
            "window width must equal marketOrdersTimeout - maxAge - 1"
        );
    }

    // -------------------------------------------------------------------------------------
    // Recovery — the property that makes the window a UX cost rather than a loss
    // -------------------------------------------------------------------------------------

    /// @notice After the timeout the trader recovers collateral without any keeper cooperation.
    /// @dev    Asserts the exact refunded amount, not merely "balance went up". `openTrade`
    ///         escrows `collateral` and separately charges the oracle fee, so the refund is the
    ///         stored `trade.collateral` — measured here rather than assumed.
    function test_traderAlwaysRecoversCollateralAfterTheTimeout() public {
        uint256 balanceBefore = IERC20(d.collateral).balanceOf(trader);
        (uint256 orderId,) = _openMarketTrade(trader, COLLATERAL, 1000, true);

        uint256 escrowed = balanceBefore - IERC20(d.collateral).balanceOf(trader);
        assertGt(escrowed, 0, "opening must escrow something");

        _advance(MARKET_ORDERS_TIMEOUT);

        vm.prank(trader);
        IOstiumTrading(d.trading).openTradeMarketTimeout(orderId);

        uint256 refunded = IERC20(d.collateral).balanceOf(trader) - (balanceBefore - escrowed);
        assertEq(refunded, COLLATERAL, "the full stored collateral must come back");

        // The residual is the oracle fee, which the protocol keeps. Stated explicitly so a change
        // to fee handling shows up here as a diff rather than as a silent balance drift.
        assertEq(
            IERC20(d.collateral).balanceOf(trader),
            balanceBefore - (escrowed - COLLATERAL),
            "only the oracle fee is retained across a timed-out order"
        );
    }

    /// @notice A censored order does not block the trader's next order: after reclaiming, the
    ///         same trader can open again and be filled normally.
    function test_traderCanTradeAgainAfterACensoredOrder() public {
        (uint256 orderId,) = _openMarketTrade(trader, COLLATERAL, 1000, true);
        _advance(MARKET_ORDERS_TIMEOUT);
        vm.prank(trader);
        IOstiumTrading(d.trading).openTradeMarketTimeout(orderId);

        (uint256 orderId2, uint32 ts2) = _openMarketTrade(trader, COLLATERAL, 1000, true);
        _deliver(orderId2, _signed(ts2, BTC_65K));

        assertGt(_collateralOf(trader, 0), 0, "a fresh order must fill after a censored one");
    }

    /// @notice Only the order's own trader may reclaim it. A third party cannot sweep pending
    ///         collateral, and cannot grief by force-cancelling a fillable order.
    function test_onlyTheOrderOwnerCanReclaim() public {
        (uint256 orderId,) = _openMarketTrade(trader, COLLATERAL, 1000, true);
        _advance(MARKET_ORDERS_TIMEOUT);

        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(IOstiumTrading.NotYourOrder.selector, orderId, trader)
        );
        IOstiumTrading(d.trading).openTradeMarketTimeout(orderId);
    }

    // -------------------------------------------------------------------------------------
    // The same censorship, applied to a CLOSE
    // -------------------------------------------------------------------------------------

    /// @dev Open a position, then request a close and abandon the order — the close-side shape of
    ///      everything above. Returns the pending order id.
    function _openThenAbandonAClose() internal returns (uint256 orderId) {
        _openPositionAtBaseline(trader, COLLATERAL);

        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarket(
            0, 0, 0, uint192(uint256(int256(BTC_65K))), 100
        );
        (orderId,) = _lastPriceRequest();
    }

    function _devFees() internal view returns (uint256) {
        return IOstiumTradingStorage(d.tradingStorage).devFees();
    }

    /// @notice **The measurement.** `closeTradeMarketTimeout` must move no USDW at all.
    ///
    /// @dev    It used to refund one oracle fee here — `refundOracleFee` plus a
    ///         `transferUsdc(storageT -> sender)` — which was balanced only by the wallet charge
    ///         `closeTradeMarket` took at request time. That charge is gone (the bond now comes
    ///         out of the position, on the paths where it has teeth), so the refund was paying
    ///         the trader out of the escrow that backs every other trader's collateral. Here it
    ///         is asserted to zero on every account at once, so a re-introduction shows up as a
    ///         balance diff rather than as slow drift nobody reads.
    function test_closeTimeoutMovesNoUsdwBecauseNoBondWasEverCharged() public {
        uint256 orderId = _openThenAbandonAClose();

        uint256 traderBefore = IERC20(d.collateral).balanceOf(trader);
        uint256 storageBefore = IERC20(d.collateral).balanceOf(d.tradingStorage);
        uint256 vaultBefore = IERC20(d.collateral).balanceOf(d.vault);
        uint256 devBefore = _devFees();
        uint256 collateralBefore = _collateralOf(trader, 0);

        _advance(MARKET_ORDERS_TIMEOUT);
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarketTimeout(orderId, false);

        assertEq(IERC20(d.collateral).balanceOf(trader), traderBefore, "the trader must be paid nothing");
        assertEq(
            IERC20(d.collateral).balanceOf(d.tradingStorage),
            storageBefore,
            "the collateral escrow must not be drawn down"
        );
        assertEq(IERC20(d.collateral).balanceOf(d.vault), vaultBefore, "the vault must be untouched");
        assertEq(_devFees(), devBefore, "devFees must not be debited");
        assertEq(_collateralOf(trader, 0), collateralBefore, "the position itself must be untouched");
    }

    /// @notice And it is repeatable, which is what made the leak a drain rather than a rounding
    ///         error: the timeout clears the `PENDING_CLOSE` trigger, so the trader can request
    ///         another close, abandon it, and reclaim again, for as long as they like.
    function test_repeatedCloseTimeoutsDrainNothing() public {
        _openPositionAtBaseline(trader, COLLATERAL);

        uint256 traderBefore = IERC20(d.collateral).balanceOf(trader);
        uint256 storageBefore = IERC20(d.collateral).balanceOf(d.tradingStorage);
        uint256 devBefore = _devFees();

        for (uint256 n = 0; n < 10; n++) {
            vm.recordLogs();
            vm.prank(trader);
            IOstiumTrading(d.trading).closeTradeMarket(
                0, 0, 0, uint192(uint256(int256(BTC_65K))), 100
            );
            (uint256 orderId,) = _lastPriceRequest();

            _advance(MARKET_ORDERS_TIMEOUT);
            vm.prank(trader);
            IOstiumTrading(d.trading).closeTradeMarketTimeout(orderId, false);
        }

        assertEq(IERC20(d.collateral).balanceOf(trader), traderBefore, "ten cycles must pay out nothing");
        assertEq(
            IERC20(d.collateral).balanceOf(d.tradingStorage), storageBefore, "and take nothing from escrow"
        );
        assertEq(_devFees(), devBefore, "and leave devFees where they were");
    }

    /// @notice **The amplifier that made this a liveness bug, not just a leak.** The refund went
    ///         through `refundOracleFee`, which reverts `RefundOracleFeeFailed` when
    ///         `devFees < amount`. Governance sweeping fees — a routine action — could therefore
    ///         weld shut the only escape from an undelivered close, for every trader at once.
    ///
    /// @dev    Driven through the real `claimFees(onlyGov)` path rather than by poking storage,
    ///         so this is the sequence an operator can actually produce.
    function test_closeTimeoutSurvivesGovSweepingEveryFee() public {
        uint256 orderId = _openThenAbandonAClose();

        uint256 fees = _devFees();
        assertGt(fees, 0, "precondition: opening must have accrued a fee to sweep");
        vm.prank(gov);
        IOstiumTradingStorage(d.tradingStorage).claimFees(fees);
        assertEq(_devFees(), 0, "precondition: devFees must be empty, the state that used to brick this");

        _advance(MARKET_ORDERS_TIMEOUT);
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarketTimeout(orderId, false);

        assertGt(_collateralOf(trader, 0), 0, "the position must survive the timeout");
    }

    /// @notice The timeout releases the `PENDING_CLOSE` trigger, so a censored close does not lock
    ///         the position shut — the close-side counterpart of
    ///         `test_traderCanTradeAgainAfterACensoredOrder`.
    function test_positionCanStillBeClosedAfterACensoredClose() public {
        uint256 orderId = _openThenAbandonAClose();

        _advance(MARKET_ORDERS_TIMEOUT);
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarketTimeout(orderId, false);

        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarket(
            0, 0, 0, uint192(uint256(int256(BTC_65K))), 100
        );
        (uint256 orderId2, uint32 ts2) = _lastPriceRequest();
        _deliver(orderId2, _signed(ts2, BTC_65K));

        assertEq(_collateralOf(trader, 0), 0, "a retried close must fill");
    }

    // -------------------------------------------------------------------------------------
    // The governance amplifier
    // -------------------------------------------------------------------------------------

    /// @notice **Finding.** `openTradeMarketTimeout` is `notDone`. If gov toggles `isDone` while
    ///         an order is pending, the trader's escrowed collateral becomes permanently
    ///         unreclaimable through this path — the refund door is welded shut on top of the
    ///         censorship window.
    ///
    /// @dev    Reported, not fixed: `OstiumTrading` is vendored and byte-identical to upstream
    ///         `8390ce49`. This test pins the behaviour so it cannot regress silently and so an
    ///         auditor sees it stated rather than inferred.
    function test_govDoneFlagStrandsPendingCollateralPermanently() public {
        (uint256 orderId,) = _openMarketTrade(trader, COLLATERAL, 1000, true);
        _advance(MARKET_ORDERS_TIMEOUT); // past the timeout: the refund is otherwise available

        vm.prank(gov);
        IOstiumTrading(d.trading).done();

        vm.prank(trader);
        vm.expectRevert(IOstiumTrading.IsDone.selector);
        IOstiumTrading(d.trading).openTradeMarketTimeout(orderId);

        // And delivery cannot rescue it either: the callback is `notDone` as well.
        assertEq(_collateralOf(trader, 0), 0, "no position exists to close instead");
    }

    /// @notice The pause flag, by contrast, does NOT strand collateral: `openTradeMarketTimeout`
    ///         is `notDone` but not `notPaused`, so a paused system still lets traders exit
    ///         pending orders. Stated as the both-ways half of the test above.
    function test_pauseDoesNotStrandPendingCollateral() public {
        (uint256 orderId,) = _openMarketTrade(trader, COLLATERAL, 1000, true);
        _advance(MARKET_ORDERS_TIMEOUT);

        vm.prank(manager);
        IOstiumTrading(d.trading).pause();

        uint256 before = IERC20(d.collateral).balanceOf(trader);
        vm.prank(trader);
        IOstiumTrading(d.trading).openTradeMarketTimeout(orderId);

        assertEq(
            IERC20(d.collateral).balanceOf(trader) - before,
            COLLATERAL,
            "a paused system must still refund a timed-out order"
        );
    }

    // -------------------------------------------------------------------------------------
    // The oracle emergency stop interacts with the same window
    // -------------------------------------------------------------------------------------

    /// @notice A guardian pause landing while an order is in flight pushes that order into the
    ///         dead window too — delivery is refused by `IsPaused` rather than `StaleReport`,
    ///         and the refund still waits for the block timeout.
    /// @dev    This is the deliberate design of the emergency stop (phase 2 §3), recorded here
    ///         because it composes with the censorship window: the trader's worst case is
    ///         `marketOrdersTimeout` blocks regardless of which door shut first.
    function test_guardianPauseAlsoPushesInFlightOrdersIntoTheWindow() public {
        uint256 openBlock = _blockNow();
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(trader, COLLATERAL, 1000, true);

        vm.prank(guardian);
        upkeep.pause();

        vm.prank(keeper);
        vm.expectRevert(WhitespacePriceUpKeep.IsPaused.selector);
        IOstiumPriceUpKeep(address(upkeep)).performUpkeep(
            abi.encode(_signed(timestamp, BTC_65K), orderId)
        );

        _advance(MARKET_ORDERS_TIMEOUT);
        assertEq(_blockNow(), openBlock + MARKET_ORDERS_TIMEOUT);

        uint256 before = IERC20(d.collateral).balanceOf(trader);
        vm.prank(trader);
        IOstiumTrading(d.trading).openTradeMarketTimeout(orderId);
        assertEq(
            IERC20(d.collateral).balanceOf(trader) - before,
            COLLATERAL,
            "a paused oracle must not block the collateral refund"
        );
    }
}
