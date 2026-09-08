// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployScript} from "../../script/Deploy.s.sol";
import {OperateScript} from "../../script/Operate.s.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPairsStorage} from "../../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {IOstiumVerifier} from "../../src/vendor/ostium/interfaces/IOstiumVerifier.sol";

contract OperateTest is Test {
    DeployScript internal deployer;
    OperateScript internal operator;
    DeployScript.Deployment internal d;

    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal marketMaker = address(0x33D);
    address internal signer = address(0x51D);
    address internal keeper = address(0x1EE);
    address internal lp = address(0x1B0);

    function setUp() public {
        deployer = new DeployScript();
        d = deployer.deployAll(
            DeployScript.Roles({
                gov: gov, dev: dev, manager: manager, owner: address(this), marketMaker: marketMaker
            })
        );
        operator = new OperateScript();
    }

    function _config() internal view returns (OperateScript.Config memory) {
        return OperateScript.Config({
            registry: d.registry, usdw: d.collateral, pairsStorage: d.pairsStorage,
            vault: d.vault, verifier: d.verifier, priceUpKeep: d.priceUpKeep,
            signer: signer, keeper: keeper, lp: lp, lpAmount: 100_000e6
        });
    }

    /// @dev Drives every step with the sender each one requires. Reused by every test here and
    ///      mirrored by `run()`, which swaps each prank for its own broadcast.
    function _configureAll() internal returns (uint16 pairIndex) {
        OperateScript.Config memory c = _config();
        vm.prank(gov);          pairIndex = operator.addMarket(c);
        vm.prank(gov);          operator.authoriseSigner(c);
        vm.prank(address(this)); operator.authoriseForwarder(c);   // registry owner
        vm.prank(gov);          operator.registerUpkeep(c);
        vm.prank(address(this)); operator.mintToLp(c);             // USDW owner
        vm.prank(lp);           uint32 settlementId = operator.requestLpDeposit(c);
        vm.prank(gov);          operator.settle(c);
        vm.prank(lp);           operator.claimLpDeposit(c, settlementId);
    }

    function test_listsPairAtIndexZero() public {
        assertEq(_configureAll(), 0);
        assertEq(IOstiumPairsStorage(d.pairsStorage).pairFeed(0), bytes32("BTC/USD"));
    }

    function test_authorisesSigner() public {
        _configureAll();
        assertTrue(IOstiumVerifier(d.verifier).isAuthorizedSigner(signer));
    }

    /// @dev The registry key is derived from Pair.oracle, not from the struct field name.
    function test_priceUpKeepRegisteredUnderOracleDerivedKey() public {
        _configureAll();
        assertEq(
            IOstiumRegistry(d.registry).getContractAddress(bytes32("BTC/USDPriceUpkeep")),
            d.priceUpKeep
        );
    }

    /// @dev Zero vault balance silently cancels every trade in the callback, so this is the
    ///      single most important post-condition of configuration.
    function test_vaultHasLiquidity() public {
        _configureAll();
        (bool ok, bytes memory ret) = d.vault.staticcall(abi.encodeWithSignature("currentBalance()"));
        assertTrue(ok);
        assertGt(abi.decode(ret, (uint256)), 0);
    }

    /// @dev Each function must no-op on a second call, because a live run that dies halfway
    ///      has to be resumable and there is not enough gas for a fresh deployment.
    function test_everyStepIsIdempotent() public {
        uint16 first = _configureAll();
        uint16 second = _configureAll();
        assertEq(first, second);
        assertEq(IOstiumPairsStorage(d.pairsStorage).pairsCount(), 1);
    }

    /// @dev Wrong sender must fail loudly rather than half-configure.
    function test_addMarketRejectsNonGov() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        operator.addMarket(_config());
    }
}
