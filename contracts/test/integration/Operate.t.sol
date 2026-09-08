// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployScript} from "../../script/Deploy.s.sol";
import {OperateScript} from "../../script/Operate.s.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPairsStorage} from "../../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {IOstiumVerifier} from "../../src/vendor/ostium/interfaces/IOstiumVerifier.sol";
import {OstiumVault} from "../../src/vendor/ostium/OstiumVault.sol";

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
    ///      mirrored by `run()`, which swaps each prank for its own broadcast. Returns
    ///      `settlementId` too (not just `pairIndex`) so idempotency tests can inspect the
    ///      vault's per-settlement state across repeated calls.
    function _configureAll() internal returns (uint16 pairIndex, uint32 settlementId) {
        OperateScript.Config memory c = _config();
        vm.prank(gov);          pairIndex = operator.addMarket(c);
        vm.prank(gov);          operator.authoriseSigner(c);
        vm.prank(address(this)); operator.authoriseForwarder(c);   // registry owner
        vm.prank(gov);          operator.registerUpkeep(c);
        vm.prank(address(this)); operator.mintToLp(c);             // USDW owner
        vm.prank(lp);           settlementId = operator.requestLpDeposit(c);
        vm.prank(gov);          operator.settle(c);
        vm.prank(lp);           operator.claimLpDeposit(c, settlementId);
    }

    function test_listsPairAtIndexZero() public {
        (uint16 pairIndex,) = _configureAll();
        assertEq(pairIndex, 0);
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
    ///      single most important post-condition of configuration. Also asserts the LP itself
    ///      holds the claimed shares (not just that the vault's total balance is non-zero) —
    ///      `currentBalance() > 0` is satisfied the moment `settle()` mints shares into the
    ///      vault's OWN escrow, before `claimDeposit` ever moves them to the LP, so this
    ///      `balanceOf(lp) > 0` assertion is what actually proves `claimLpDeposit` ran.
    function test_vaultHasLiquidity() public {
        _configureAll();
        (bool ok, bytes memory ret) = d.vault.staticcall(abi.encodeWithSignature("currentBalance()"));
        assertTrue(ok);
        assertGt(abi.decode(ret, (uint256)), 0);
        assertGt(IERC20(d.vault).balanceOf(lp), 0);
    }

    /// @dev Each function must no-op on a second full pass, because a live run that dies
    ///      halfway has to be resumable and there is not enough gas for a fresh deployment.
    ///      `pairIndex`/`pairsCount` alone only exercises `addMarket` — it cannot catch a
    ///      function that silently mints USDW twice, deposits twice, or never actually claims
    ///      (all three hid behind the same `currentBalance() > 0` predicate at one point), so
    ///      this snapshots the USDW/vault-supply and per-LP state across both passes and
    ///      asserts none of it moved on the second one.
    function test_everyStepIsIdempotent() public {
        (uint16 firstPair, uint32 firstSettlementId) = _configureAll();

        uint256 usdwSupplyAfterFirst = IERC20(d.collateral).totalSupply();
        uint256 vaultSupplyAfterFirst = IERC20(d.vault).totalSupply();
        uint256 lpSharesAfterFirst = IERC20(d.vault).balanceOf(lp);
        uint256 pendingAfterFirst = OstiumVault(d.vault).pendingDepositRequest(lp, firstSettlementId);

        assertGt(lpSharesAfterFirst, 0, "first pass must actually deliver claimed shares to the LP");
        assertEq(pendingAfterFirst, 0, "first pass must clear the pending deposit request on claim");

        (uint16 secondPair, uint32 secondSettlementId) = _configureAll();

        assertEq(secondPair, firstPair);
        assertEq(IOstiumPairsStorage(d.pairsStorage).pairsCount(), 1);

        // requestLpDeposit must resume/skip rather than issue a second real request.
        assertEq(secondSettlementId, 0);

        assertEq(IERC20(d.collateral).totalSupply(), usdwSupplyAfterFirst, "USDW must not be minted twice");
        assertEq(IERC20(d.vault).totalSupply(), vaultSupplyAfterFirst, "vault shares must not be minted twice");
        assertEq(IERC20(d.vault).balanceOf(lp), lpSharesAfterFirst, "LP share balance must be stable");
    }

    /// @dev Wrong sender must fail loudly rather than half-configure. Pinned to the exact
    ///      error and offending address — a bare `vm.expectRevert()` cannot distinguish "the
    ///      wrong sender was correctly rejected" from "`_relay` broke and pairsStorage rejected
    ///      this script contract's own address instead".
    function test_addMarketRejectsNonGov() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(IOstiumPairsStorage.NotGov.selector, address(0xBAD)));
        operator.addMarket(_config());
    }

    /// @dev `_relay` must fail LOUDLY, not silently misattribute, when `vm.prank` fails for a
    ///      reason unrelated to broadcasting. An outer `vm.startPrank` left active across the
    ///      call into `addMarket` reproduces exactly that: the inner `vm.prank(gov)` `_relay`
    ///      attempts collides with the still-active outer prank ("cannot override an ongoing
    ///      prank with a single vm.prank"). An earlier version of `_relay` swallowed any
    ///      `vm.prank` failure in a bare `try/catch`, which would have let this nested call
    ///      through misattributed as `address(operator)` instead of surfacing the conflict.
    function test_relayFailsLoudlyOnConflictingOuterPrank() public {
        vm.startPrank(gov);
        vm.expectRevert();
        operator.addMarket(_config());
        vm.stopPrank();
    }
}
