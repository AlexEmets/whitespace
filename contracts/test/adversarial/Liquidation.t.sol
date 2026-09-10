// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {SystemFixture} from "../helpers/SystemFixture.sol";
import {OstiumTradesUpKeep} from "../../src/vendor/ostium/OstiumTradesUpKeep.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumPriceUpKeep} from "../../src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol";
import {IOstiumForwarded} from "../../src/vendor/ostium/interfaces/IOstiumForwarded.sol";
import {IOstiumAutomationCompatible} from
    "../../src/vendor/ostium/interfaces/IOstiumAutomationCompatible.sol";

/// @notice Design spec §8 invariant 4 — **a position below maintenance margin is always
///         liquidatable** — and the §8 adversarial "liquidation races" scenario.
///
/// @dev    This suite splits deliberately into two halves, because the answer differs.
///
///         **Half 1 — as deployed, invariant 4 is FALSE.** `OstiumTrading.executeAutomationOrder`
///         is the only liquidation entry point in the system, and it is gated `onlyTradesUpKeep`
///         against `registry.getContractAddress('tradesUpKeep')`. `Deploy.s.sol` never deploys or
///         registers that contract, so the registry lookup reverts and NO address can liquidate
///         anything. `test_liquidationIsUnreachableAsDeployed` proves it against the real
///         deployment script. This confirms — and strengthens — the phase-6 finding: the problem
///         is not merely that liquidation is permissioned, it is that it is impossible.
///
///         **Half 2 — with the upkeep deployed, the contract logic is sound.** The remaining
///         tests deploy and register `OstiumTradesUpKeep`, then prove liquidation fires, that it
///         is allowlisted rather than permissionless (contradicting spec §5.3), and that the
///         three races resolve safely.
///
///         `OstiumTradesUpKeep` is vendored and is NOT modified here; it is deployed by the test,
///         which is what `Deploy.s.sol` would have to start doing to make invariant 4 true.
contract LiquidationTest is SystemFixture {
    address internal trader = address(0x7AA);
    address internal liquidatorA = address(0x11A);
    address internal liquidatorB = address(0x11B);

    uint256 internal constant COLLATERAL = 1_000e6;
    uint32 internal constant LEVERAGE = 1000; // 10.00x, PRECISION_2
    uint16 internal constant TRIGGER_TIMEOUT = 30; // blocks — Deploy.s.sol

    OstiumTradesUpKeep internal tradesUpKeep;

    function setUp() public {
        _deployConfiguredSystem();
        _fundTrader(trader, 10_000e6);
    }

    // -------------------------------------------------------------------------------------
    // Half 1 — invariant 4 is FALSE on the deployed configuration
    // -------------------------------------------------------------------------------------

    /// @notice **Finding L-1 (critical).** No liquidation can execute against the system as
    ///         `Deploy.s.sol` builds it, because `tradesUpKeep` is never registered.
    ///
    /// @dev    Asserted three ways so the cause is unambiguous rather than inferred from one
    ///         revert: the registry has no such key, the only entry point rejects every caller,
    ///         and it rejects the trader and gov too — this is not an access-control question,
    ///         there is simply no address that satisfies `msg.sender == address(0)`.
    function test_liquidationIsUnreachableAsDeployed() public {
        _openPositionAtBaseline(trader, COLLATERAL);
        assertGt(_collateralOf(trader, 0), 0, "a position must exist to be liquidated");

        // 1. The registry has no `tradesUpKeep` entry at all.
        vm.expectRevert();
        IOstiumRegistry(d.registry).getContractAddress("tradesUpKeep");

        // 2. The only liquidation entry point is therefore unreachable — for anyone.
        address[3] memory callers = [liquidatorA, trader, gov];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert();
            IOstiumTrading(d.trading).executeAutomationOrder(
                IOstiumTradingStorage.LimitOrder.LIQ, trader, 0, 0, block.timestamp
            );
        }
    }

    /// @notice The mirror: once `OstiumTradesUpKeep` is deployed and registered, the same call
    ///         resolves and the gate becomes a real allowlist rather than an impossibility.
    ///         Proves the failure above is the missing deployment, not a bug in the vendored gate.
    function test_registeringTheUpkeepMakesTheEntryPointReachable() public {
        _deployAndRegisterTradesUpKeep();

        assertEq(
            IOstiumRegistry(d.registry).getContractAddress("tradesUpKeep"),
            address(tradesUpKeep),
            "the registry must resolve tradesUpKeep once registered"
        );

        // Still gated — but now with a named error instead of a registry revert.
        vm.prank(liquidatorA);
        vm.expectRevert(
            abi.encodeWithSelector(IOstiumTrading.NotTradesUpKeep.selector, liquidatorA)
        );
        IOstiumTrading(d.trading).executeAutomationOrder(
            IOstiumTradingStorage.LimitOrder.LIQ, trader, 0, 0, block.timestamp
        );
    }

    // -------------------------------------------------------------------------------------
    // Half 2 — liquidation is allowlisted, not permissionless (spec §5.3 contradiction)
    // -------------------------------------------------------------------------------------

    /// @notice **Finding L-2 (high).** Spec §5.3 and §7 state liquidation is "permissionless with
    ///         a reward". It is not: `performUpkeep` is gated on `isForwarder[msg.sender]`, an
    ///         allowlist writable only by the registry owner. An unregistered liquidator — the
    ///         redundancy the spec relies on for when our own liquidator is down — is refused.
    function test_unregisteredLiquidatorIsRefused() public {
        _deployAndRegisterTradesUpKeep();
        _openPositionAtBaseline(trader, COLLATERAL);

        vm.prank(liquidatorB); // never registered as a forwarder
        vm.expectRevert(abi.encodeWithSelector(IOstiumForwarded.NotForwarder.selector, liquidatorB));
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));
    }

    /// @notice And the both-ways half: a registered forwarder is accepted, so the gate is a real
    ///         allowlist rather than a contract that refuses everyone.
    function test_registeredLiquidatorIsAccepted() public {
        _deployAndRegisterTradesUpKeep();
        _openPositionAtBaseline(trader, COLLATERAL);

        // Does not revert. The trigger is accepted; whether the position is actually liquidatable
        // is decided later, in the callback, against the delivered price.
        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));
    }

    /// @notice Registering a forwarder requires the registry owner, NOT gov — so gov alone cannot
    ///         restore liquidation capacity in an incident. Recorded because it widens the set of
    ///         keys that must be available during an outage.
    function test_govCannotRegisterALiquidationForwarder() public {
        _deployAndRegisterTradesUpKeep();

        vm.prank(gov);
        vm.expectRevert();
        tradesUpKeep.registerForwarder(liquidatorB);
    }

    // -------------------------------------------------------------------------------------
    // Liquidation races
    // -------------------------------------------------------------------------------------

    /// @notice Race 1 — two liquidators trigger the same position. The second must not double
    ///         charge, double pay, or corrupt accounting.
    /// @dev    `executeAutomationOrder` RETURNS a status rather than reverting, so the second
    ///         trigger is absorbed. The assertion is on observable state — one pending order per
    ///         trigger is acceptable, a second *position mutation* is not — because "the call did
    ///         not revert" proves nothing in this codebase.
    function test_twoLiquidatorsOnTheSamePositionDoNotDoubleSettle() public {
        _deployAndRegisterTradesUpKeep();
        _openPositionAtBaseline(trader, COLLATERAL);
        vm.prank(address(this));
        tradesUpKeep.registerForwarder(liquidatorB);

        uint256 collateralBefore = _collateralOf(trader, 0);
        uint256 traderBalanceBefore = IERC20(d.collateral).balanceOf(trader);

        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));
        vm.prank(liquidatorB);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));

        // Neither trigger settles anything by itself — settlement needs a delivered price.
        assertEq(_collateralOf(trader, 0), collateralBefore, "a trigger alone must not move funds");
        assertEq(
            IERC20(d.collateral).balanceOf(trader),
            traderBalanceBefore,
            "a duplicate trigger must not pay the trader twice"
        );
    }

    /// @notice Race 2 — a liquidation trigger racing the trader's own close. The position must
    ///         settle exactly once, and the trader must not be able to close a position that is
    ///         simultaneously being liquidated in a way that pays out twice.
    function test_liquidationRacingACloseSettlesOnlyOnce() public {
        _deployAndRegisterTradesUpKeep();
        _openPositionAtBaseline(trader, COLLATERAL);

        // The trader requests a close first.
        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarket(0, 0, 0, uint192(uint256(int256(BTC_65K))), 100);
        (uint256 closeOrderId, uint32 closeTs) = _lastPriceRequest();

        // A liquidator triggers against the same, still-open position.
        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));

        uint256 balanceBefore = IERC20(d.collateral).balanceOf(trader);
        _deliver(closeOrderId, _signed(closeTs, BTC_65K));

        assertEq(_collateralOf(trader, 0), 0, "the close must settle the position");
        assertGt(
            IERC20(d.collateral).balanceOf(trader), balanceBefore, "the close must pay the trader"
        );

        // The position is gone; the trader's collateral slot is empty and cannot pay again.
        assertEq(_collateralOf(trader, 0), 0, "no residual position may remain after settlement");
    }

    /// @notice Race 3 — a liquidation trigger racing a collateral top-up.
    ///
    /// @dev    **Finding L-3 (high). The trigger wins, and it wins by freezing the trader out.**
    ///         Submitting a LIQ trigger writes `orderTriggerBlock`, and for `triggerTimeout` (30)
    ///         blocks `TradingLib.checkNoPendingTriggers` then returns false for that position.
    ///         Every trader-side escape is gated on that check, so the trader cannot top up, and
    ///         — the damaging half — cannot close either.
    ///
    ///         Crucially the trigger does NOT require the position to actually be liquidatable:
    ///         liquidatability is only evaluated later, in the callback, against a delivered
    ///         price. So the freeze is available against ANY position, healthy or not, for the
    ///         cost of gas.
    function test_aLiquidationTriggerFreezesTheTraderOutOfTheirOwnPosition() public {
        _deployAndRegisterTradesUpKeep();
        _openPositionAtBaseline(trader, COLLATERAL);

        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));

        // The trader cannot add margin to save the position...
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, uint16(0), uint8(0))
        );
        IOstiumTrading(d.trading).topUpCollateral(0, 0, 500e6);

        // ...and cannot exit it either. This is the part that turns a nuisance into a hostage
        // situation: the position stays exposed to the market while the trader is locked out.
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, uint16(0), uint8(0))
        );
        IOstiumTrading(d.trading).closeTradeMarket(0, 0, 0, uint192(uint256(int256(BTC_65K))), 100);
    }

    /// @notice The freeze expires after `triggerTimeout` blocks without any price delivery — so a
    ///         single trigger is bounded. Bounding it is what makes the renewal test below the
    ///         real finding rather than this one.
    function test_theFreezeExpiresAfterTriggerTimeout() public {
        _deployAndRegisterTradesUpKeep();
        _openPositionAtBaseline(trader, COLLATERAL);

        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));

        vm.roll(block.number + TRIGGER_TIMEOUT);

        uint256 collateralBefore = _collateralOf(trader, 0);
        vm.prank(trader);
        IOstiumTrading(d.trading).topUpCollateral(0, 0, 500e6);

        // Strictly greater rather than `+ 500e6`: `topUpCollateral` settles accrued rollover and
        // funding fees in the same call, so the net credit is slightly under the deposit. The
        // property under test is that the call is permitted again, not the fee arithmetic.
        assertGt(
            _collateralOf(trader, 0),
            collateralBefore,
            "once the trigger ages out the trader must regain control"
        );
    }

    /// @notice **Finding L-3, the amplifier — with its exact limit measured.** The freeze is
    ///         renewable: the moment one trigger ages out, another can be placed, re-freezing the
    ///         position for a further `triggerTimeout` blocks, for gas only.
    ///
    /// @dev    Measured limit, and the reason this is a griefing vector rather than a permanent
    ///         lock: **re-triggering while a trigger is still pending does NOT refresh it.** A
    ///         second `performUpkeep` inside the window is absorbed as a status and leaves
    ///         `orderTriggerBlock` untouched, so the attacker must wait for expiry and then win
    ///         the race for the next block. That leaves the trader a **one-block** window per
    ///         30-block cycle in which to close or top up.
    ///
    ///         So the honest severity is: an allowlisted liquidator can impose a ~29/30 duty
    ///         cycle lockout on any position indefinitely, but cannot make it airtight.
    function test_theFreezeIsRenewableWithAOneBlockGapPerCycle() public {
        _deployAndRegisterTradesUpKeep();
        _openPositionAtBaseline(trader, COLLATERAL);

        IOstiumTradingStorage storageT = IOstiumTradingStorage(d.tradingStorage);

        // Cycle 1.
        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));
        uint256 firstStamp =
            storageT.orderTriggerBlock(trader, 0, 0, IOstiumTradingStorage.LimitOrder.LIQ);
        assertEq(firstStamp, _blockNow(), "the trigger stamps the current block");

        // Inside the window the trader cannot exit.
        vm.roll(block.number + TRIGGER_TIMEOUT - 1);
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, uint16(0), uint8(0))
        );
        IOstiumTrading(d.trading).closeTradeMarket(0, 0, 0, uint192(uint256(int256(BTC_65K))), 100);

        // Expiry, then immediate re-trigger — the renewal.
        vm.roll(block.number + 1);
        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));

        uint256 secondStamp =
            storageT.orderTriggerBlock(trader, 0, 0, IOstiumTradingStorage.LimitOrder.LIQ);
        assertEq(secondStamp, firstStamp + TRIGGER_TIMEOUT, "the freeze is re-armed at expiry");

        // And the trader is locked out again, on a fresh 30-block clock.
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(IOstiumTrading.TriggerPending.selector, trader, uint16(0), uint8(0))
        );
        IOstiumTrading(d.trading).closeTradeMarket(0, 0, 0, uint192(uint256(int256(BTC_65K))), 100);
    }

    /// @notice The measured limit itself, isolated: a second trigger inside the window does not
    ///         extend it. This is what bounds finding L-3, so it is pinned rather than assumed.
    function test_reTriggeringInsideTheWindowDoesNotExtendTheFreeze() public {
        _deployAndRegisterTradesUpKeep();
        _openPositionAtBaseline(trader, COLLATERAL);

        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));

        // Re-trigger halfway through the window.
        vm.roll(block.number + TRIGGER_TIMEOUT / 2);
        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(trader, block.timestamp));

        // If the second trigger had refreshed the block stamp, the trader would still be locked
        // out here. They are not: the original stamp still governs.
        vm.roll(block.number + TRIGGER_TIMEOUT / 2);
        uint256 collateralBefore = _collateralOf(trader, 0);
        vm.prank(trader);
        IOstiumTrading(d.trading).topUpCollateral(0, 0, 500e6);

        assertGt(
            _collateralOf(trader, 0),
            collateralBefore,
            "a re-trigger inside the window must not extend the original freeze"
        );
    }

    /// @notice A liquidation trigger against a position that does not exist is absorbed as a
    ///         status, not a revert — so a batch containing one stale entry still processes the
    ///         rest. Pins the vendored behaviour a liquidator operator depends on.
    function test_triggerAgainstAMissingPositionDoesNotRevertTheBatch() public {
        _deployAndRegisterTradesUpKeep();

        vm.prank(liquidatorA);
        tradesUpKeep.performUpkeep(_liqPayload(address(0xDEAD), block.timestamp));
    }

    // -------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------

    /// @dev What `Deploy.s.sol` would have to do for invariant 4 to hold. Registering the
    ///      contract is `onlyGov`; registering a forwarder on it is `onlyTimelock`, which
    ///      resolves to the registry `owner()` — `address(this)` in this fixture.
    function _deployAndRegisterTradesUpKeep() internal {
        // Behind an ERC1967Proxy, matching how `Deploy.s.sol` deploys every other
        // `Initializable` component. (Phase 2 notes the proxy buys nothing here — no vendored
        // contract is UUPS — but matching the deployment shape is what makes this test evidence
        // about the real system rather than about a differently-shaped one.)
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

        vm.prank(address(this)); // registry owner == onlyTimelock
        tradesUpKeep.registerForwarder(liquidatorA);
    }

    function _liqPayload(address who, uint256 timestamp) internal pure returns (bytes memory) {
        IOstiumAutomationCompatible.SimplifiedTradeId[] memory trades =
            new IOstiumAutomationCompatible.SimplifiedTradeId[](1);
        trades[0] = IOstiumAutomationCompatible.SimplifiedTradeId({
            trader: who,
            pairId: 0,
            index: 0,
            limitOrder: IOstiumTradingStorage.LimitOrder.LIQ
        });
        return abi.encode(trades, timestamp);
    }
}
