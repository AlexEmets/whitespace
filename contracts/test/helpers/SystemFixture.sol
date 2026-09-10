// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployScript} from "../../script/Deploy.s.sol";
import {OperateScript} from "../../script/Operate.s.sol";
import {USDW} from "../../src/mocks/USDW.sol";
import {WhitespaceVerifier} from "../../src/oracle/WhitespaceVerifier.sol";
import {WhitespacePriceUpKeep} from "../../src/oracle/WhitespacePriceUpKeep.sol";
import {IOstiumPriceUpKeep} from "../../src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {ReportLib} from "./ReportLib.sol";

/// @notice The full production system, deployed and configured exactly as phase 1 deployed it and
///         phase 2 migrated it: `DeployScript.deployAll` builds the vendored Ostium stack,
///         `OperateScript` configures a tradeable BTC/USD market and seeds the LP vault, and the
///         phase-2 oracle migration then swaps the k-of-N verifier and the railed upkeep
///         underneath the already-live market.
///
/// @dev    Extracted so the phase-7 invariant and adversarial suites all drive the SAME system
///         `OracleHardening.t.sol` proves the oracle against, rather than each re-deriving a
///         setup that could quietly diverge from it.
///
///         **This fixture installs the HARDENED oracle.** Chain 1874 does not have it — the live
///         deployment still points at the vendored 1-of-N `OstiumVerifier` (see
///         `docs/decisions/phase-7-hardening.md`, finding H-2). Tests here therefore describe the
///         intended production shape, not the currently deployed one.
abstract contract SystemFixture is Test {
    // N=5 authorised signing keys, k=3 — the parameters spec §6.2 locks.
    uint256 internal constant K1 = 0xA11CE01;
    uint256 internal constant K2 = 0xA11CE02;
    uint256 internal constant K3 = 0xA11CE03;
    uint256 internal constant K4 = 0xA11CE04;
    uint256 internal constant K5 = 0xA11CE05;
    uint256 internal constant THRESHOLD = 3;

    bytes32 internal constant FEED = "BTC/USD";
    int192 internal constant BTC_65K = 65_000e18; // 18 decimals. NOT 65_000e8.

    uint32 internal constant MAX_AGE = 10; // seconds  — spec §5.2
    uint16 internal constant MAX_DEVIATION_BPS = 500; // 5.00%
    uint16 internal constant MARKET_ORDERS_TIMEOUT = 30; // blocks — Deploy.s.sol

    DeployScript internal deployer;
    OperateScript internal operator;
    DeployScript.Deployment internal d;

    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal marketMaker = address(0x33D);
    address internal keeper = address(0x1EE);
    address internal lp = address(0x1B0);
    address internal guardian = address(0x64A);

    WhitespaceVerifier internal verifier;
    WhitespacePriceUpKeep internal upkeep;

    uint256[] internal allKeys;

    /// @dev Split from `setUp` so a test that needs a different pre-state (an unseeded vault, a
    ///      second market) can compose the steps itself.
    function _deployConfiguredSystem() internal {
        allKeys = [K1, K2, K3, K4, K5];

        deployer = new DeployScript();
        d = deployer.deployAll(
            DeployScript.Roles({
                gov: gov, dev: dev, manager: manager, owner: address(this), marketMaker: marketMaker
            })
        );
        operator = new OperateScript();

        _configureVendoredSystem();
        _installHardenedOracle();
    }

    /// @notice Read the current block number in a way the optimiser cannot fold.
    ///
    /// @dev    **Do not replace uses of this with `uint256 x = block.number`.** Under this repo's
    ///         mandatory `via_ir = true`, solc 0.8.24 treats `block.number` as invariant within a
    ///         call frame and folds a captured local back into a live re-read — so a value
    ///         "captured" before `vm.roll` silently becomes the POST-roll value and any assertion
    ///         against it is vacuous.
    ///
    ///         Measured: capture 1, `vm.roll(+29)`, then the local reads **30** while a storage
    ///         copy and `vm.getBlockNumber()` both correctly read **1**. The cheatcode is an
    ///         external call the optimiser cannot fold. The same hazard applies to
    ///         `block.timestamp` across `vm.warp`.
    ///
    ///         See `docs/decisions/phase-7-hardening.md`, finding T-1.
    function _blockNow() internal view returns (uint256) {
        return vm.getBlockNumber();
    }

    function _config() internal view returns (OperateScript.Config memory) {
        return OperateScript.Config({
            registry: d.registry, usdw: d.collateral, pairsStorage: d.pairsStorage,
            vault: d.vault, verifier: d.verifier, priceUpKeep: d.priceUpKeep,
            signer: vm.addr(K1), keeper: keeper, lp: lp, lpAmount: 100_000e6
        });
    }

    function _oracleConfig() internal view returns (OperateScript.OracleConfig memory) {
        address[] memory signers = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            signers[i] = vm.addr(allKeys[i]);
        }
        return OperateScript.OracleConfig({
            registry: d.registry, signers: signers, threshold: THRESHOLD,
            guardian: guardian, keeper: keeper, maxAge: MAX_AGE, maxDeviationBps: MAX_DEVIATION_BPS
        });
    }

    /// @dev The phase-1 state: a BTC/USD market configured against the vendored single-signer
    ///      oracle, with the LP vault seeded so `currentBalance()` is non-zero. Without the seed
    ///      every open silently cancels with `EXPOSURE_LIMITS` — see `TradeLocal.t.sol`.
    function _configureVendoredSystem() internal {
        OperateScript.Config memory c = _config();
        vm.prank(gov);           uint16 pairIndex = operator.addMarket(c);
        vm.prank(manager);       operator.setMaxOi(c, pairIndex);
        vm.prank(gov);           operator.approveVaultAllowance(c);
        vm.prank(gov);           operator.authoriseSigner(c);
        vm.prank(address(this)); operator.authoriseForwarder(c);   // registry owner
        vm.prank(gov);           operator.registerUpkeep(c);
        vm.prank(address(this)); operator.mintToLp(c);             // USDW owner
        vm.prank(lp);            uint32 settlementId = operator.requestLpDeposit(c);
        vm.prank(gov);           operator.settle(c);
        vm.prank(lp);            operator.claimLpDeposit(c, settlementId);
    }

    /// @dev The phase-2 migration, driven one role per step exactly as `runOracle()` drives it.
    function _installHardenedOracle() internal {
        OperateScript.OracleConfig memory oc = _oracleConfig();
        vm.prank(gov);           address v = operator.installHardenedVerifier(oc);
        vm.prank(gov);           operator.authoriseHardenedSigners(oc);
        vm.prank(gov);           address u = operator.installHardenedUpkeep(oc);
        vm.prank(address(this)); operator.authoriseHardenedForwarder(oc); // registry owner
        vm.prank(gov);           operator.configureOracleRails(oc);

        verifier = WhitespaceVerifier(v);
        upkeep = WhitespacePriceUpKeep(u);
    }

    // -------------------------------------------------------------------------------------
    // Report construction
    // -------------------------------------------------------------------------------------

    /// @dev A k-of-N (3-of-5) signed report over the standard BTC/USD payload.
    function _signed(uint32 timestamp, int192 price) internal view returns (bytes memory) {
        return _signedWith(timestamp, price, ReportLib.keys3(K1, K2, K3));
    }

    function _signedWith(uint32 timestamp, int192 price, uint256[] memory keys)
        internal
        view
        returns (bytes memory)
    {
        return ReportLib.signedReport(
            ReportLib.btcReport(address(verifier), FEED, timestamp, price), keys
        );
    }

    // -------------------------------------------------------------------------------------
    // Trading
    // -------------------------------------------------------------------------------------

    function _fundTrader(address who, uint256 amount) internal {
        USDW(d.collateral).mint(who, amount);
        // Collateral is pulled by tradingStorage, not by the trading entrypoint.
        vm.prank(who);
        IERC20(d.collateral).approve(d.tradingStorage, type(uint256).max);
    }

    /// @dev `PriceRequestedV2(uint256 indexed orderId, OrderType, bytes32 feed, uint256 timestamp)`.
    ///      Both values must come out of the log: the upkeep rejects any report whose timestamp is
    ///      not byte-identical to the one it recorded for the order.
    function _lastPriceRequest() internal returns (uint256 orderId, uint32 timestamp) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("PriceRequestedV2(uint256,uint8,bytes32,uint256)");
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory log = logs[i - 1];
            if (log.topics.length > 1 && log.topics[0] == sig) {
                orderId = uint256(log.topics[1]);
                (,, uint256 ts) = abi.decode(log.data, (uint8, bytes32, uint256));
                return (orderId, uint32(ts));
            }
        }
        revert("no PriceRequestedV2 emitted");
    }

    function _openMarketTrade(address who, uint256 collateral, uint32 leverage, bool buy)
        internal
        returns (uint256 orderId, uint32 timestamp)
    {
        vm.recordLogs();
        vm.prank(who);
        IOstiumTrading(d.trading).openTrade(
            IOstiumTradingStorage.Trade({
                collateral: collateral,
                openPrice: uint192(uint256(int256(BTC_65K))),
                tp: 0,
                sl: 0,
                trader: who,
                leverage: leverage, // PRECISION_2: 1000 == 10.00x
                pairIndex: 0,
                index: 0,
                buy: buy,
                isDayTrade: false
            }),
            IOstiumTradingStorage.BuilderFee({builder: address(0), builderFee: 0}),
            IOstiumTradingStorage.OpenOrderType.MARKET,
            100
        );
        return _lastPriceRequest();
    }

    function _deliver(uint256 orderId, bytes memory report) internal {
        vm.prank(keeper);
        IOstiumPriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    function _collateralOf(address who, uint8 index) internal view returns (uint256 collateral) {
        (collateral,,,,,,,,,) = IOstiumTradingStorage(d.tradingStorage).openTrades(who, 0, index);
    }

    /// @dev Opens a position at $65,000 and delivers a valid report, which also establishes the
    ///      deviation rail's baseline for BTC/USD.
    function _openPositionAtBaseline(address who, uint256 collateral) internal {
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(who, collateral, 1000, true);
        _deliver(orderId, _signed(timestamp, BTC_65K));
    }
}
