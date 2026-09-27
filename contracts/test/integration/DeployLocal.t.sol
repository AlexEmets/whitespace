// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DeployScript, SystemDeployer} from "../../script/Deploy.s.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {OstiumVault} from "../../src/vendor/ostium/OstiumVault.sol";
import {OstiumPairInfos} from "../../src/vendor/ostium/OstiumPairInfos.sol";

contract DeployLocalTest is Test {
    DeployScript internal deployer;
    SystemDeployer.Deployment internal d;

    // Four mutually distinct addresses: OstiumRegistry rejects any collision.
    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal marketMaker = address(0x33D);

    function setUp() public {
        deployer = new DeployScript();
        d = deployer.deployAll(
            SystemDeployer.Roles({
                gov: gov,
                dev: dev,
                manager: manager,
                owner: address(this),
                marketMaker: marketMaker
            })
        );
    }

    function test_rolesAreDistinctAndAssigned() public view {
        IOstiumRegistry registry = IOstiumRegistry(d.registry);
        assertEq(registry.gov(), gov);
        assertEq(registry.dev(), dev);
        assertEq(registry.manager(), manager);
        // Pins the ownership handover. The deployment temporarily parks `gov` and `owner`
        // on a throwaway RegistryBootstrap; without this assertion, dropping the final
        // `transferOwnership` would leave the registry owned forever by that contract and
        // every other test here would still pass. Asserting all four roles equal the four
        // expected distinct addresses is equivalent to proving the bootstrap holds none.
        assertEq(Ownable(d.registry).owner(), address(this));
    }

    /// @dev Guards the migration-chain replay.
    ///
    ///      The stored version is NOT by itself a guard: OZ's `reinitializer(n)` sets
    ///      `_initialized = n` unconditionally, so calling `initializeV4` alone also reports
    ///      4 while V2 and V3 are skipped permanently. The version assertions below prove
    ///      only that the highest reinitializer ran; the state assertions are what prove the
    ///      intermediate ones ran too.
    ///
    ///      `maxSettlementInterval` is written by `OstiumVault.initializeV3` and by nothing
    ///      else (OstiumVault.sol:151), so it is 0 on a vault that skipped V3. That is the
    ///      discriminating check. Most other reinitializers write nothing observable on a
    ///      greenfield replay (their bodies loop over the empty market arrays, or rewrite a
    ///      value `initialize` already set); the task report records that per contract.
    function test_migrationChainFullyReplayed() public view {
        assertEq(_initializedVersion(d.vault), 4);
        assertEq(_initializedVersion(d.pairInfos), 4);
        assertEq(_initializedVersion(d.pairsStorage), 2);
        assertEq(_initializedVersion(d.openPnl), 2);

        // OstiumVault V3 — written only by initializeV3 (OstiumVault.sol:151).
        assertEq(OstiumVault(d.vault).maxSettlementInterval(), 24 hours);

        // OstiumVault V4 — initializeV4 sets marketMaker (OstiumVault.sol:183) and its
        // _updateAccPnlPerTokenUsed() bumps lastSettlementId off 0 (OstiumVault.sol:793).
        // Nothing else in the suite pins that V4's argument was wired correctly.
        assertEq(OstiumVault(d.vault).marketMaker(), marketMaker);
        assertEq(OstiumVault(d.vault).lastSettlementId(), 1);

        // OstiumPairInfos configuration. NOT a V3 discriminator: `initialize`
        // (OstiumPairInfos.sol:79-80) writes these same two fields with the same values,
        // so this pins configuration only.
        assertEq(OstiumPairInfos(d.pairInfos).liqMarginThresholdP(), 25);
        assertEq(OstiumPairInfos(d.pairInfos).maxNegativePnlOnOpenP(), 40);
    }

    /// @dev OZ v5 stores `_initialized` (uint64) in the first slot of the
    ///      InitializableStorage namespace.
    function _initializedVersion(address proxy) internal view returns (uint64) {
        bytes32 slot = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;
        return uint64(uint256(vm.load(proxy, slot)));
    }

    function test_registryKnowsEveryComponent() public view {
        IOstiumRegistry registry = IOstiumRegistry(d.registry);
        assertEq(registry.getContractAddress("tradingStorage"), d.tradingStorage);
        assertEq(registry.getContractAddress("pairsStorage"), d.pairsStorage);
        assertEq(registry.getContractAddress("pairInfos"), d.pairInfos);
        assertEq(registry.getContractAddress("trading"), d.trading);
        assertEq(registry.getContractAddress("callbacks"), d.callbacks);
        assertEq(registry.getContractAddress("vault"), d.vault);
        assertEq(registry.getContractAddress("openPnl"), d.openPnl);
        assertEq(registry.getContractAddress("priceRouter"), d.priceRouter);
        assertEq(registry.getContractAddress("ostiumVerifier"), d.verifier);
    }

    /// @dev Covers all TWELVE fields the Deployment struct exports, not just the nine the
    ///      registry knows about. `collateral`, `verifier` and `priceUpKeep` are returned to
    ///      the operator and written into deployments/<chainid>.json, so a silently-zero
    ///      address in any of them is just as damaging as in a registered component.
    function test_everyComponentHasCode() public view {
        address[12] memory all = [
            d.registry, d.collateral, d.tradingStorage, d.pairsStorage, d.pairInfos,
            d.trading, d.callbacks, d.vault, d.openPnl, d.priceRouter,
            d.verifier, d.priceUpKeep
        ];
        for (uint256 i = 0; i < all.length; i++) {
            assertGt(all[i].code.length, 0);
        }
    }

    /// @dev Pins the priceUpKeep omission as INTENTIONAL, not forgotten.
    ///
    ///      `Deployment.priceUpKeep` is a local field name, not a registry key. The real key
    ///      is per-oracle and not a constant — OstiumPriceRouter.sol:81-84 and
    ///      OstiumTradingCallbacks.sol:83-85 both resolve it as
    ///      `bytes32(abi.encodePacked(pairsStorage.oracle(pairIndex), 'PriceUpkeep'))`, which
    ///      is undeterminable until pairs exist. Phase 1 adds none, so not registering it is
    ///      correct.
    ///
    ///      Without this assertion, a future change that "helpfully" registers the upkeep
    ///      under the literal name "priceUpKeep" would pass the whole suite while creating a
    ///      registry entry no consumer ever reads — and would look authoritative to whoever
    ///      wires phase 3. `OstiumRegistry.getContractAddress` reverts `NotFound(bytes32)`
    ///      (OstiumRegistry.sol:114, declared IOstiumRegistry.sol:13) for an unknown name.
    function test_priceUpKeepIsNotRegisteredUnderItsStructName() public {
        vm.expectRevert(abi.encodeWithSelector(IOstiumRegistry.NotFound.selector, bytes32("priceUpKeep")));
        IOstiumRegistry(d.registry).getContractAddress("priceUpKeep");
    }

    function test_collateralIsSixDecimals() public view {
        (bool ok, bytes memory ret) = d.collateral.staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint8)), 6);
    }

    /// @dev `OstiumVault.initialize(address _asset, address _registry, ...)` takes two
    ///      same-typed addresses in a row. Swapping them compiles and deploys cleanly,
    ///      so only this assertion catches it.
    function test_vaultAssetIsCollateralNotRegistry() public view {
        (bool ok, bytes memory ret) = d.vault.staticcall(abi.encodeWithSignature("asset()"));
        assertTrue(ok);
        address asset = abi.decode(ret, (address));
        assertEq(asset, d.collateral);
        assertTrue(asset != d.registry);
    }
}
