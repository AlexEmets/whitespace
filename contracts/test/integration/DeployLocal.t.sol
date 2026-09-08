// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployScript} from "../../script/Deploy.s.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";

contract DeployLocalTest is Test {
    DeployScript internal deployer;
    DeployScript.Deployment internal d;

    // Four mutually distinct addresses: OstiumRegistry rejects any collision.
    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal marketMaker = address(0x33D);

    function setUp() public {
        deployer = new DeployScript();
        d = deployer.deployAll(
            DeployScript.Roles({
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
    }

    /// @dev Guards the migration-chain replay: if any reinitializer were skipped,
    ///      the stored version would be lower than the highest one upstream defines.
    function test_migrationChainFullyReplayed() public view {
        assertEq(_initializedVersion(d.vault), 4);
        assertEq(_initializedVersion(d.pairInfos), 4);
        assertEq(_initializedVersion(d.pairsStorage), 2);
        assertEq(_initializedVersion(d.openPnl), 2);
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

    function test_everyComponentHasCode() public view {
        address[9] memory all = [
            d.registry, d.tradingStorage, d.pairsStorage, d.pairInfos,
            d.trading, d.callbacks, d.vault, d.openPnl, d.priceRouter
        ];
        for (uint256 i = 0; i < all.length; i++) {
            assertGt(all[i].code.length, 0);
        }
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
