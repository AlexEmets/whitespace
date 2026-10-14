// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployScript, SystemDeployer} from "../../script/Deploy.s.sol";
import {OperateScript} from "../../script/Operate.s.sol";
import {USDW} from "../../src/mocks/USDW.sol";
import {IWhitespaceRegistry} from "../../src/vendor/ostium/interfaces/IWhitespaceRegistry.sol";
import {IWhitespaceTrading} from "../../src/vendor/ostium/interfaces/IWhitespaceTrading.sol";
import {IWhitespaceTradingStorage} from "../../src/vendor/ostium/interfaces/IWhitespaceTradingStorage.sol";
import {IWhitespacePriceUpKeep} from "../../src/vendor/ostium/interfaces/IWhitespacePriceUpKeep.sol";
import {IWhitespaceForwarded} from "../../src/vendor/ostium/interfaces/IWhitespaceForwarded.sol";
import {IWhitespaceVerifier} from "../../src/vendor/ostium/interfaces/IWhitespaceVerifier.sol";
import {WhitespaceVerifier} from "../../src/oracle/WhitespaceVerifier.sol";
import {WhitespacePriceUpKeep} from "../../src/oracle/WhitespacePriceUpKeep.sol";
import {ReportLib} from "../helpers/ReportLib.sol";

/// @notice The hardened oracle, end to end on a real system: `Deploy.s.sol` builds the full
///         Ostium stack with the VENDORED single-signer verifier and upkeep, `Operate.s.sol`
///         configures a tradeable BTC/USD market against them, and only then does the phase-2
///         migration swap both contracts underneath a live, already-configured market. That
///         ordering is the point — chain 1874 is already in exactly this state, so a test that
///         installed the hardened oracle from scratch would not exercise the path that has to
///         work.
///
/// @dev    Layer 2 (the rails) is proven here BOTH ways: each rail has a test that trips it and
///         a test that does not. A rail suite that only shows rejections cannot tell a working
///         rail from one that rejects everything — and a rail that rejects everything is a dead
///         exchange, which is a worse outcome than the failure the rail was added to prevent.
///
///         Every `vm.expectRevert` is pinned to the exact error payload.
/// @dev A hardened upkeep from before `baselineMaxAge` existed: it answers `maxAge()` (so the
///      script recognises it as hardened) but not `baselineMaxAge()`. Only the getters the
///      upgrade path reads are implemented.
contract OutdatedHardenedUpkeepStub {
    bool public paused;
    mapping(bytes32 => bool) public isFeedHalted;

    function maxAge() external pure returns (uint32) {
        return 10;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setHalted(bytes32 feed, bool h) external {
        isFeedHalted[feed] = h;
    }
}

contract OracleHardeningTest is Test {
    // N=5 authorised signing keys, k=3.
    uint256 internal constant K1 = 0xA11CE01;
    uint256 internal constant K2 = 0xA11CE02;
    uint256 internal constant K3 = 0xA11CE03;
    uint256 internal constant K4 = 0xA11CE04;
    uint256 internal constant K5 = 0xA11CE05;
    uint256 internal constant ROGUE = 0xBADBAD;
    uint256 internal constant THRESHOLD = 3;

    bytes32 internal constant FEED = "BTC/USD";
    bytes32 internal constant OTHER_FEED = "ETH/USD";
    bytes32 internal constant PRICE_UPKEEP_KEY = "BTC/USDPriceUpkeep";

    int192 internal constant BTC_65K = 65_000e18; // $65,000.00, 18 decimals
    int192 internal constant BTC_PLUS_1PCT = 65_650e18; // +1.00%, inside the 500 bps rail
    int192 internal constant BTC_PLUS_6PCT = 68_900e18; // +6.00%, outside it

    uint32 internal constant MAX_AGE = 10;
    uint16 internal constant MAX_DEVIATION_BPS = 500;

    DeployScript internal deployer;
    OperateScript internal operator;
    SystemDeployer.Deployment internal d;

    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal marketMaker = address(0x33D);
    address internal keeper = address(0x1EE);
    address internal lp = address(0x1B0);
    address internal trader = address(0x7AA);
    address internal guardian = address(0x64A);

    WhitespaceVerifier internal verifier;
    WhitespacePriceUpKeep internal upkeep;

    uint256[] internal allKeys;

    function setUp() public {
        allKeys = [K1, K2, K3, K4, K5];

        deployer = new DeployScript();
        d = deployer.deployAll(
            SystemDeployer.Roles({
                gov: gov, dev: dev, manager: manager, owner: address(this), marketMaker: marketMaker
            })
        );
        operator = new OperateScript();

        _configureVendoredSystem();
        _installHardenedOracle();
    }

    // -------------------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------------------

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
            registry: d.registry,
            signers: signers,
            threshold: THRESHOLD,
            guardian: guardian,
            keeper: keeper,
            maxAge: MAX_AGE,
            maxDeviationBps: MAX_DEVIATION_BPS
        });
    }

    /// @dev The phase-1 state: a market configured against the vendored single-signer oracle.
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

    /// @dev The phase-2 migration, driven exactly as `runOracle()` drives it — one role per step.
    function _installHardenedOracle() internal returns (address v, address u) {
        OperateScript.OracleConfig memory oc = _oracleConfig();
        vm.prank(gov);           v = operator.installHardenedVerifier(oc);
        vm.prank(gov);           operator.authoriseHardenedSigners(oc);
        vm.prank(gov);           u = operator.installHardenedUpkeep(oc);
        vm.prank(address(this)); operator.authoriseHardenedForwarder(oc); // registry owner
        vm.prank(gov);           operator.configureOracleRails(oc);

        verifier = WhitespaceVerifier(v);
        upkeep = WhitespacePriceUpKeep(u);
    }

    function _report(uint32 timestamp, int192 price) internal view returns (ReportLib.Report memory) {
        return ReportLib.btcReport(address(verifier), FEED, timestamp, price);
    }

    /// @dev A k-of-N signed report over the standard BTC/USD payload.
    function _signed(uint32 timestamp, int192 price) internal view returns (bytes memory) {
        return ReportLib.signedReport(_report(timestamp, price), ReportLib.keys3(K1, K2, K3));
    }

    function _fundTrader(uint256 amount) internal {
        USDW(d.collateral).mint(trader, amount);
        vm.prank(trader);
        IERC20(d.collateral).approve(d.tradingStorage, type(uint256).max);
    }

    /// @dev `PriceRequestedV2(uint256 indexed orderId, OrderType, bytes32 feed, uint256 timestamp)`.
    ///      Both values must come out of the log: the upkeep rejects any report whose timestamp
    ///      is not byte-identical to the one it recorded.
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

    function _openMarketTrade(uint256 collateral) internal returns (uint256 orderId, uint32 timestamp) {
        vm.recordLogs();
        vm.prank(trader);
        IWhitespaceTrading(d.trading).openTrade(
            IWhitespaceTradingStorage.Trade({
                collateral: collateral,
                openPrice: uint192(uint256(int256(BTC_65K))),
                tp: 0,
                sl: 0,
                trader: trader,
                leverage: 1000, // 10.00x, PRECISION_2
                pairIndex: 0,
                index: 0,
                buy: true,
                isDayTrade: false
            }),
            IWhitespaceTradingStorage.BuilderFee({builder: address(0), builderFee: 0}),
            IWhitespaceTradingStorage.OpenOrderType.MARKET,
            100
        );
        return _lastPriceRequest();
    }

    function _requestClose() internal returns (uint256 orderId, uint32 timestamp) {
        vm.recordLogs();
        vm.prank(trader);
        IWhitespaceTrading(d.trading).closeTradeMarket(0, 0, 0, uint192(uint256(int256(BTC_65K))), 100);
        return _lastPriceRequest();
    }

    function _deliver(uint256 orderId, bytes memory report) internal {
        vm.prank(keeper);
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    function _openCollateral() internal view returns (uint256 collateral) {
        (collateral,,,,,,,,,) = IWhitespaceTradingStorage(d.tradingStorage).openTrades(trader, 0, 0);
    }

    /// @dev Opens a position and delivers a valid report at $65,000, which also establishes the
    ///      deviation rail's baseline for BTC/USD.
    function _openPositionAtBaseline() internal {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);
        _deliver(orderId, _signed(timestamp, BTC_65K));
        assertGt(_openCollateral(), 0, "baseline setup must leave a position open");
        assertEq(upkeep.lastPrice(FEED), BTC_65K, "baseline setup must record the price");
    }

    // -------------------------------------------------------------------------------------
    // Installation and migration
    // -------------------------------------------------------------------------------------

    function test_registryPointsAtTheHardenedContracts() public view {
        IWhitespaceRegistry reg = IWhitespaceRegistry(d.registry);
        assertEq(reg.getContractAddress("ostiumVerifier"), address(verifier));
        assertEq(reg.getContractAddress(PRICE_UPKEEP_KEY), address(upkeep));
        assertTrue(address(verifier) != d.verifier, "the vendored verifier must be replaced");
        assertTrue(address(upkeep) != d.priceUpKeep, "the vendored upkeep must be replaced");
    }

    function test_installedWithTheSpecifiedThresholdAndSigners() public view {
        assertEq(verifier.threshold(), THRESHOLD);
        assertEq(verifier.signerCount(), 5);
        for (uint256 i = 0; i < 5; i++) {
            assertTrue(verifier.isAuthorizedSigner(vm.addr(allKeys[i])));
        }
        assertEq(upkeep.maxAge(), MAX_AGE);
        assertEq(upkeep.maxDeviationBps(), MAX_DEVIATION_BPS);
        assertEq(upkeep.guardian(), guardian);
        assertTrue(IWhitespaceForwarded(address(upkeep)).isForwarder(keeper));
    }

    /// @dev A second full pass must deploy nothing and change nothing — the same resumability
    ///      requirement the eight phase-1 steps carry, for the same reason: a live run that dies
    ///      halfway has to be safe to re-run, and re-deploying the verifier would orphan the
    ///      signer set gov had already curated on the incumbent.
    function test_installIsIdempotent() public {
        address verifierBefore = address(verifier);
        address upkeepBefore = address(upkeep);

        (address v, address u) = _installHardenedOracle();

        assertEq(v, verifierBefore, "a replayed install must not deploy a second verifier");
        assertEq(u, upkeepBefore, "a replayed install must not deploy a second upkeep");
        assertEq(verifier.signerCount(), 5, "a replayed install must not re-register signers");
        assertEq(
            IWhitespaceRegistry(d.registry).getContractAddress("ostiumVerifier"),
            verifierBefore,
            "the registry pointer must not move on a replay"
        );
    }

    /// @dev Listing a second market must point that market's own registry key at the SAME upkeep
    ///      instance, not at a second deployment. The upkeep's per-market state is keyed by feed
    ///      inside the contract (`isFeedHalted`, `lastPrice`), so two instances would split the
    ///      breaker and the deviation baseline across contracts that neither knows about — and
    ///      would give the guardian two `pause()` switches where the design specifies one.
    function test_oneUpkeepInstanceServesEveryRegisteredFeed() public {
        IWhitespaceRegistry reg = IWhitespaceRegistry(d.registry);
        bytes32 ethKey = "ETH/USDPriceUpkeep";

        bytes32[] memory feedKeys = new bytes32[](2);
        feedKeys[0] = PRICE_UPKEEP_KEY;
        feedKeys[1] = ethKey;

        vm.prank(gov);
        address u = operator.installHardenedUpkeep(_oracleConfig(), feedKeys);

        assertEq(u, address(upkeep), "adding a feed must reuse the installed upkeep");
        assertEq(reg.getContractAddress(PRICE_UPKEEP_KEY), address(upkeep));
        assertEq(reg.getContractAddress(ethKey), address(upkeep), "ETH must resolve to it too");
    }

    /// @dev The derived key must be byte-identical to the literal the vendored contracts compute.
    ///      `WhitespacePriceRouter.sol:81-83` and `WhitespaceTradingCallbacks.sol:83-85` both look the
    ///      upkeep up under `bytes32(abi.encodePacked(pair.oracle, "PriceUpkeep"))`. A market
    ///      registered under a key that differs by one byte lists successfully, then reverts
    ///      `NotFound` on its first price request — so this equality is load-bearing, not cosmetic.
    function test_derivedUpkeepKeyMatchesTheVendoredDerivation() public pure {
        assertEq(bytes32(abi.encodePacked("BTC/USD", "PriceUpkeep")), bytes32("BTC/USDPriceUpkeep"));
        assertEq(bytes32(abi.encodePacked("ETH/USD", "PriceUpkeep")), bytes32("ETH/USDPriceUpkeep"));
    }

    /// @dev The healing path: a verifier that already exists but whose signer set drifted (a key
    ///      revoked out of band) is brought back into line by `authoriseHardenedSigners`, which
    ///      is the only step that can — `installHardenedVerifier` returns early in that case.
    function test_signerReconciliationHealsADriftedSignerSet() public {
        vm.prank(gov);
        verifier.unregisterAuthorizedSigner(vm.addr(K5));
        assertEq(verifier.signerCount(), 4);

        vm.prank(gov);
        operator.authoriseHardenedSigners(_oracleConfig());

        assertEq(verifier.signerCount(), 5);
        assertTrue(verifier.isAuthorizedSigner(vm.addr(K5)));
    }

    function test_installHardenedVerifierRejectsNonGov() public {
        // Fresh system, so the install has work to do and reaches the registry write.
        SystemDeployer.Deployment memory fresh = new DeployScript().deployAll(
            SystemDeployer.Roles({
                gov: gov, dev: dev, manager: manager, owner: address(this), marketMaker: marketMaker
            })
        );
        OperateScript.OracleConfig memory oc = _oracleConfig();
        oc.registry = fresh.registry;

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(IWhitespaceRegistry.NotGov.selector, address(0xBAD)));
        operator.installHardenedVerifier(oc);
    }

    // -------------------------------------------------------------------------------------
    // End to end — the hardened path still trades
    // -------------------------------------------------------------------------------------

    /// @dev The gate for the whole phase: a complete open -> close cycle where every price is
    ///      carried by three independent signatures. Mirrors `TradeLocal.t.sol`'s
    ///      `test_openAndClosePosition`, which does the same through the single-signer path.
    function test_openAndClosePositionThroughThresholdOracle() public {
        _fundTrader(10_000e6);

        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);
        _deliver(orderId, _signed(timestamp, BTC_65K));

        assertGt(_openCollateral(), 0, "a valid 3-of-5 report must open the position");
        assertEq(upkeep.lastPrice(FEED), BTC_65K, "an accepted price must become the baseline");

        uint256 balanceBeforeClose = IERC20(d.collateral).balanceOf(trader);

        (uint256 closeOrderId, uint32 closeTimestamp) = _requestClose();
        _deliver(closeOrderId, _signed(closeTimestamp, BTC_65K));

        assertEq(_openCollateral(), 0, "closing must clear the position");
        assertGt(
            IERC20(d.collateral).balanceOf(trader),
            balanceBeforeClose,
            "the closed position must return collateral to the trader"
        );
    }

    /// @dev All five signatures, not just the threshold three.
    function test_acceptsMoreThanTheThreshold() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);
        _deliver(orderId, ReportLib.signedReport(_report(timestamp, BTC_65K), allKeys));
        assertGt(_openCollateral(), 0);
    }

    // -------------------------------------------------------------------------------------
    // Layer 1 reached through the upkeep — proves the verifier is actually wired in
    // -------------------------------------------------------------------------------------

    function test_belowThresholdReportIsRejectedAtDelivery() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        bytes memory report =
            ReportLib.signedReport(_report(timestamp, BTC_65K), ReportLib.keys2(K1, K2));

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.InsufficientSignatures.selector, 2, THRESHOLD)
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));

        assertEq(_openCollateral(), 0, "a rejected report must leave no position");
    }

    function test_replayedSignatureIsRejectedAtDelivery() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        bytes memory report =
            ReportLib.signedReport(_report(timestamp, BTC_65K), ReportLib.keys3(K1, K1, K1));

        vm.prank(keeper);
        vm.expectRevert(WhitespaceVerifier.SignersNotAscending.selector);
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    function test_unauthorisedSignerIsRejectedAtDelivery() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        // Sorted, so the ascending rule cannot fire and mask the real reason. ROGUE is the only
        // unauthorised key present, so wherever it lands in the ordering it is the first — and
        // only — signature that fails, and the error names it.
        uint256[] memory keys = ReportLib.keys3(K1, K2, ROGUE);
        bytes memory report = ReportLib.signedReport(_report(timestamp, BTC_65K), keys);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IWhitespaceVerifier.NotAuthorizedSigner.selector, vm.addr(ROGUE))
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    /// @dev Domain separation, reached through the real delivery path: a report signed for
    ///      mainnet 1875 cannot be delivered on this chain.
    function test_foreignChainReportIsRejectedAtDelivery() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        ReportLib.Report memory r = _report(timestamp, BTC_65K);
        r.chainId = 1875;
        bytes memory report = ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3));

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.WrongChain.selector, 1875, block.chainid)
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    /// @dev And a report addressed to the retired vendored verifier is equally useless.
    function test_foreignVerifierReportIsRejectedAtDelivery() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        ReportLib.Report memory r = _report(timestamp, BTC_65K);
        r.verifier = d.verifier; // the replaced single-signer instance
        bytes memory report = ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3));

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespaceVerifier.WrongVerifier.selector, d.verifier, address(verifier)
            )
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    // -------------------------------------------------------------------------------------
    // Rail 1 — staleness
    // -------------------------------------------------------------------------------------

    /// @dev Does NOT trip: delivered exactly `maxAge` seconds after the request. The boundary is
    ///      `block.timestamp > timestamp + maxAge`, so `== maxAge` must still be accepted — an
    ///      off-by-one here would cut the keeper's real budget by a whole block.
    function test_staleRailAcceptsAtTheBoundary() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        vm.warp(uint256(timestamp) + MAX_AGE);
        _deliver(orderId, _signed(timestamp, BTC_65K));

        assertGt(_openCollateral(), 0, "a report delivered at exactly maxAge must be accepted");
    }

    /// @dev Trips: one second past the budget.
    function test_staleRailRejectsOneSecondLate() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        uint256 late = uint256(timestamp) + MAX_AGE + 1;
        vm.warp(late);

        bytes memory report = _signed(timestamp, BTC_65K);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespacePriceUpKeep.StaleReport.selector, timestamp, late, MAX_AGE
            )
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));

        assertEq(_openCollateral(), 0, "a stale report must leave no position");
    }

    /// @dev The rail is a parameter, not a constant: widening it makes the same late report land.
    function test_govCanWidenTheStaleRail() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        vm.warp(uint256(timestamp) + 60);
        vm.prank(gov);
        upkeep.setMaxAge(120);

        _deliver(orderId, _signed(timestamp, BTC_65K));
        assertGt(_openCollateral(), 0);
    }

    // -------------------------------------------------------------------------------------
    // Upgrading an outdated hardened upkeep
    // -------------------------------------------------------------------------------------

    /// @dev Points the BTC/USD key at an upkeep built before the stale-baseline fix, the state
    ///      chain 1874 is in. A plain reuse-if-hardened check would keep it forever.
    function _pointAtOutdatedUpkeep(bool paused, bool btcHalted) internal returns (OutdatedHardenedUpkeepStub stub) {
        stub = new OutdatedHardenedUpkeepStub();
        stub.setPaused(paused);
        stub.setHalted(FEED, btcHalted);
        vm.prank(gov);
        IWhitespaceRegistry(d.registry).updateContract(PRICE_UPKEEP_KEY, address(stub));
    }

    function test_installReplacesAnOutdatedHardenedUpkeep() public {
        OutdatedHardenedUpkeepStub stub = _pointAtOutdatedUpkeep(false, false);

        vm.prank(gov);
        address u = operator.installHardenedUpkeep(_oracleConfig());

        assertTrue(u != address(stub), "an outdated upkeep must be replaced, not reused");
        assertEq(IWhitespaceRegistry(d.registry).getContractAddress(PRICE_UPKEEP_KEY), u);
        assertEq(WhitespacePriceUpKeep(u).baselineMaxAge(), 15 minutes);
        assertFalse(WhitespacePriceUpKeep(u).paused());
        assertFalse(WhitespacePriceUpKeep(u).isFeedHalted(FEED));

        vm.prank(gov);
        address again = operator.installHardenedUpkeep(_oracleConfig());
        assertEq(again, u, "once current, a replay must reuse it");
    }

    function test_upgradeCarriesOverPauseAndHaltedFeeds() public {
        _pointAtOutdatedUpkeep(true, true);

        vm.prank(gov);
        address u = operator.installHardenedUpkeep(_oracleConfig());

        assertTrue(WhitespacePriceUpKeep(u).paused(), "a pause must survive the upgrade");
        assertTrue(WhitespacePriceUpKeep(u).isFeedHalted(FEED), "a halted feed must stay halted");
    }

    function test_upgradedUpkeepTradesOnceItsForwarderIsAuthorised() public {
        _pointAtOutdatedUpkeep(false, false);
        OperateScript.OracleConfig memory oc = _oracleConfig();
        vm.prank(gov);           address u = operator.installHardenedUpkeep(oc);
        vm.prank(address(this)); operator.authoriseHardenedForwarder(oc);
        vm.prank(gov);           operator.configureOracleRails(oc);
        upkeep = WhitespacePriceUpKeep(u);

        _openPositionAtBaseline();
    }

    // -------------------------------------------------------------------------------------
    // Rail 2 — deviation from the last accepted price
    // -------------------------------------------------------------------------------------

    /// @dev The first accepted price for a feed has nothing to be compared against, so it is
    ///      deliberately NOT rail-checked — it only establishes the baseline. Proven with a
    ///      price so far from the market that any baseline would have rejected it.
    function test_firstPriceSetsTheBaselineWithoutARailCheck() public {
        assertEq(upkeep.lastPrice(FEED), 0, "a fresh install has no baseline");

        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);
        _deliver(orderId, _signed(timestamp, 1_000_000e18)); // $1,000,000 — 15x the market

        assertEq(upkeep.lastPrice(FEED), 1_000_000e18, "the first price must become the baseline");
    }

    /// @dev Does NOT trip: a +1.00% move, well inside the 500 bps rail, closes the position.
    function test_deviationRailAcceptsANormalMove() public {
        _openPositionAtBaseline();

        (uint256 closeOrderId, uint32 closeTimestamp) = _requestClose();
        _deliver(closeOrderId, _signed(closeTimestamp, BTC_PLUS_1PCT));

        assertEq(_openCollateral(), 0, "a 1% move must close the position normally");
        assertEq(upkeep.lastPrice(FEED), BTC_PLUS_1PCT, "the baseline must advance");
    }

    /// @dev Trips: a +6.00% jump against a 500 bps rail. This is the failure k-of-N cannot catch
    ///      — five honest signers handed the same broken aggregate all sign it truthfully.
    function test_deviationRailRejectsAJump() public {
        _openPositionAtBaseline();
        (uint256 closeOrderId, uint32 closeTimestamp) = _requestClose();

        bytes memory report = _signed(closeTimestamp, BTC_PLUS_6PCT);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespacePriceUpKeep.PriceDeviationTooLarge.selector,
                FEED,
                BTC_65K,
                BTC_PLUS_6PCT,
                MAX_DEVIATION_BPS
            )
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, closeOrderId));

        assertGt(_openCollateral(), 0, "a rejected report must leave the position untouched");
        assertEq(upkeep.lastPrice(FEED), BTC_65K, "a rejected price must not move the baseline");
    }

    /// @dev Symmetric: a -6.00% crash is rejected the same way an equal rally is.
    function test_deviationRailRejectsADownwardJump() public {
        _openPositionAtBaseline();
        (uint256 closeOrderId, uint32 closeTimestamp) = _requestClose();

        int192 crash = 61_100e18; // -6.00%
        bytes memory report = _signed(closeTimestamp, crash);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespacePriceUpKeep.PriceDeviationTooLarge.selector,
                FEED,
                BTC_65K,
                crash,
                MAX_DEVIATION_BPS
            )
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, closeOrderId));
    }

    /// @dev The recovery path, and the reason `clearPriceBaseline` exists. A genuine >5% move
    ///      wedges the feed permanently: every honest report afterwards deviates from a baseline
    ///      that no longer reflects the market. Gov drops the baseline and the same report lands.
    function test_govCanClearTheBaselineToUnwedgeAFeed() public {
        _openPositionAtBaseline();
        (uint256 closeOrderId, uint32 closeTimestamp) = _requestClose();
        bytes memory report = _signed(closeTimestamp, BTC_PLUS_6PCT);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespacePriceUpKeep.PriceDeviationTooLarge.selector,
                FEED, BTC_65K, BTC_PLUS_6PCT, MAX_DEVIATION_BPS
            )
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, closeOrderId));

        vm.prank(gov);
        upkeep.clearPriceBaseline(FEED);
        assertEq(upkeep.lastPrice(FEED), 0);

        _deliver(closeOrderId, report); // the exact same bytes now land
        assertEq(_openCollateral(), 0, "after clearing the baseline the close must go through");
        assertEq(upkeep.lastPrice(FEED), BTC_PLUS_6PCT);
    }

    /// @dev The wedge `clearPriceBaseline` used to be the only way out of. The baseline moves
    ///      only when an order fills, so a feed nobody trades for a while keeps an old price,
    ///      and a genuine move since then must not lock the feed. Seen on 1874: ETH and SOL
    ///      drifted ~8% from their last fill and every report after that reverted.
    function test_deviationRailIgnoresABaselineOlderThanBaselineMaxAge() public {
        _openPositionAtBaseline();
        vm.warp(block.timestamp + upkeep.baselineMaxAge() + 1);

        (uint256 closeOrderId, uint32 closeTimestamp) = _requestClose();
        _deliver(closeOrderId, _signed(closeTimestamp, BTC_PLUS_6PCT));

        assertEq(_openCollateral(), 0, "a stale baseline must not block the close");
        assertEq(upkeep.lastPrice(FEED), BTC_PLUS_6PCT, "the accepted price must become the new baseline");
        assertEq(upkeep.lastPriceAt(FEED), closeTimestamp, "the new baseline must carry its report time");
    }

    /// @dev The other side of the boundary: a baseline exactly `baselineMaxAge` old is still
    ///      fresh, so a jump against it is still the aggregation bug rail 2 exists to catch.
    function test_deviationRailStillAppliesAtTheBaselineMaxAgeBoundary() public {
        _openPositionAtBaseline();
        vm.warp(block.timestamp + upkeep.baselineMaxAge());

        (uint256 closeOrderId, uint32 closeTimestamp) = _requestClose();
        bytes memory report = _signed(closeTimestamp, BTC_PLUS_6PCT);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespacePriceUpKeep.PriceDeviationTooLarge.selector,
                FEED, BTC_65K, BTC_PLUS_6PCT, MAX_DEVIATION_BPS
            )
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, closeOrderId));
    }

    function test_baselineMaxAgeDefaultsToFifteenMinutes() public view {
        assertEq(upkeep.baselineMaxAge(), 15 minutes);
    }

    function test_govCanSetBaselineMaxAge() public {
        vm.prank(gov);
        upkeep.setBaselineMaxAge(1 hours);
        assertEq(upkeep.baselineMaxAge(), 1 hours);

        _openPositionAtBaseline();
        vm.warp(block.timestamp + 16 minutes); // past the old default, inside the new value
        (uint256 closeOrderId, uint32 closeTimestamp) = _requestClose();
        bytes memory report = _signed(closeTimestamp, BTC_PLUS_6PCT);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespacePriceUpKeep.PriceDeviationTooLarge.selector,
                FEED, BTC_65K, BTC_PLUS_6PCT, MAX_DEVIATION_BPS
            )
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, closeOrderId));
    }

    function test_setBaselineMaxAgeRejectsZeroAndNonGov() public {
        vm.prank(gov);
        vm.expectRevert(IWhitespacePriceUpKeep.WrongParams.selector);
        upkeep.setBaselineMaxAge(0);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.NotGov.selector, guardian));
        upkeep.setBaselineMaxAge(1 hours);
    }

    function test_clearPriceBaselineAlsoClearsItsTimestamp() public {
        _openPositionAtBaseline();
        assertGt(upkeep.lastPriceAt(FEED), 0, "an accepted price must record its time");

        vm.prank(gov);
        upkeep.clearPriceBaseline(FEED);
        assertEq(upkeep.lastPriceAt(FEED), 0);
    }

    /// @dev A zero or negative price on an open market is rejected outright. Without this,
    ///      `lastPrice == 0` would be ambiguous between "no baseline" and "the baseline is zero",
    ///      and a zero price reaching the callbacks reads as MARKET_CLOSED rather than as an error.
    function test_nonPositivePriceIsRejected() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        bytes memory report = _signed(timestamp, 0);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(WhitespacePriceUpKeep.NonPositivePrice.selector, FEED, int192(0))
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    // -------------------------------------------------------------------------------------
    // Rail 3 — per-market circuit breaker
    // -------------------------------------------------------------------------------------

    /// @dev Does NOT trip: halting a DIFFERENT feed leaves BTC/USD trading. This is the whole
    ///      claim of a per-market breaker — an incident on one asset must not stop the others.
    function test_haltingAnotherFeedDoesNotStopThisOne() public {
        vm.prank(guardian);
        upkeep.haltFeed(OTHER_FEED);

        assertTrue(upkeep.isFeedHalted(OTHER_FEED));
        assertFalse(upkeep.isFeedHalted(FEED));

        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);
        _deliver(orderId, _signed(timestamp, BTC_65K));
        assertGt(_openCollateral(), 0, "an unrelated feed's halt must not block this market");
    }

    /// @dev Trips at REQUEST time: a halted feed refuses to accept new orders at all, so the
    ///      trader's `openTrade` reverts and no collateral moves. The alternative — accepting the
    ///      order and refusing the delivery — would strand collateral until the timeout.
    function test_haltedFeedRejectsNewOrders() public {
        vm.prank(guardian);
        upkeep.haltFeed(FEED);

        _fundTrader(10_000e6);
        uint256 balanceBefore = IERC20(d.collateral).balanceOf(trader);

        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(WhitespacePriceUpKeep.FeedHalted.selector, FEED));
        IWhitespaceTrading(d.trading).openTrade(
            IWhitespaceTradingStorage.Trade({
                collateral: 1000e6, openPrice: uint192(uint256(int256(BTC_65K))), tp: 0, sl: 0,
                trader: trader, leverage: 1000, pairIndex: 0, index: 0, buy: true, isDayTrade: false
            }),
            IWhitespaceTradingStorage.BuilderFee({builder: address(0), builderFee: 0}),
            IWhitespaceTradingStorage.OpenOrderType.MARKET,
            100
        );

        assertEq(
            IERC20(d.collateral).balanceOf(trader), balanceBefore, "no collateral may be taken"
        );
    }

    /// @dev Trips at DELIVERY time too: an order already in flight when the halt lands cannot be
    ///      filled. Halting only new requests would leave a window in which the very price the
    ///      guardian distrusts still executes.
    function test_haltedFeedRejectsInFlightDelivery() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        vm.prank(guardian);
        upkeep.haltFeed(FEED);

        bytes memory report = _signed(timestamp, BTC_65K);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WhitespacePriceUpKeep.FeedHalted.selector, FEED));
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    function test_govCanResumeAHaltedFeed() public {
        vm.prank(guardian);
        upkeep.haltFeed(FEED);
        vm.prank(gov);
        upkeep.resumeFeed(FEED);

        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);
        _deliver(orderId, _signed(timestamp, BTC_65K));
        assertGt(_openCollateral(), 0, "a resumed feed must trade again");
    }

    /// @dev The asymmetry: the guardian is a hot key that can stop the exchange but must not be
    ///      able to restart it.
    function test_guardianCannotResumeAFeed() public {
        vm.prank(guardian);
        upkeep.haltFeed(FEED);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.NotGov.selector, guardian));
        upkeep.resumeFeed(FEED);
    }

    function test_randomAddressCannotHaltAFeed() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(WhitespacePriceUpKeep.NotGuardianOrGov.selector, address(0xBAD))
        );
        upkeep.haltFeed(FEED);
    }

    // -------------------------------------------------------------------------------------
    // Rail 4 — global pause
    // -------------------------------------------------------------------------------------

    /// @dev Does NOT trip while unpaused — the baseline case for the two tests below.
    function test_unpausedSystemTrades() public {
        assertFalse(upkeep.paused());
        _openPositionAtBaseline();
    }

    function test_guardianPauseBlocksNewOrders() public {
        vm.prank(guardian);
        upkeep.pause();
        assertTrue(upkeep.paused());

        _fundTrader(10_000e6);
        vm.prank(trader);
        vm.expectRevert(WhitespacePriceUpKeep.IsPaused.selector);
        IWhitespaceTrading(d.trading).openTrade(
            IWhitespaceTradingStorage.Trade({
                collateral: 1000e6, openPrice: uint192(uint256(int256(BTC_65K))), tp: 0, sl: 0,
                trader: trader, leverage: 1000, pairIndex: 0, index: 0, buy: true, isDayTrade: false
            }),
            IWhitespaceTradingStorage.BuilderFee({builder: address(0), builderFee: 0}),
            IWhitespaceTradingStorage.OpenOrderType.MARKET,
            100
        );
    }

    function test_guardianPauseBlocksInFlightDelivery() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        vm.prank(guardian);
        upkeep.pause();

        bytes memory report = _signed(timestamp, BTC_65K);
        vm.prank(keeper);
        vm.expectRevert(WhitespacePriceUpKeep.IsPaused.selector);
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    /// @dev Immediate, no timelock, and reversible only by gov — then the exchange resumes.
    function test_govUnpauseRestoresTrading() public {
        vm.prank(guardian);
        upkeep.pause();
        vm.prank(gov);
        upkeep.unpause();

        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);
        _deliver(orderId, _signed(timestamp, BTC_65K));
        assertGt(_openCollateral(), 0, "an unpaused system must trade again");
    }

    function test_guardianCannotUnpause() public {
        vm.prank(guardian);
        upkeep.pause();

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.NotGov.selector, guardian));
        upkeep.unpause();
    }

    function test_randomAddressCannotPause() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(WhitespacePriceUpKeep.NotGuardianOrGov.selector, address(0xBAD))
        );
        upkeep.pause();
    }

    // -------------------------------------------------------------------------------------
    // Parameters are gov-only
    // -------------------------------------------------------------------------------------

    /// @dev The guardian's power stops at the emergency stop. It may not retune the rails —
    ///      widening `maxDeviationBps` to 100% would disarm layer 2 without pausing anything,
    ///      which is precisely the move a compromised hot key would want.
    function test_guardianCannotChangeParameters() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.NotGov.selector, guardian));
        upkeep.setMaxDeviationBps(10_000);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.NotGov.selector, guardian));
        upkeep.setMaxAge(3600);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.NotGov.selector, guardian));
        upkeep.setGuardian(address(0xBAD));
    }

    function test_railParametersRejectDisablingValues() public {
        vm.prank(gov);
        vm.expectRevert(IWhitespacePriceUpKeep.WrongParams.selector);
        upkeep.setMaxAge(0);

        vm.prank(gov);
        vm.expectRevert(IWhitespacePriceUpKeep.WrongParams.selector);
        upkeep.setMaxDeviationBps(0);

        vm.prank(gov);
        vm.expectRevert(IWhitespacePriceUpKeep.WrongParams.selector);
        upkeep.setMaxDeviationBps(10_001);
    }

    // -------------------------------------------------------------------------------------
    // Vendored behaviour that must be preserved
    // -------------------------------------------------------------------------------------

    /// @dev The two-phase guarantee. A report whose timestamp is not byte-identical to the one
    ///      recorded at request time is refused, which is what forces the price to be signed
    ///      AFTER the trader committed.
    function test_wrongTimestampStillReverts() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        bytes memory report = _signed(timestamp + 1, BTC_65K);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.InvalidPrice.selector, orderId));
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    /// @dev A report for the wrong feed cannot be applied to this order.
    function test_wrongFeedStillReverts() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        ReportLib.Report memory r = _report(timestamp, BTC_65K);
        r.feedId = OTHER_FEED;
        bytes memory report = ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3));

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.InvalidPrice.selector, orderId));
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    function test_nonForwarderStillReverts() public {
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        bytes memory report = _signed(timestamp, BTC_65K);
        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(IWhitespaceForwarded.NotForwarder.selector, address(0xBAD))
        );
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    function test_unknownOrderStillReverts() public {
        bytes memory report = _signed(uint32(block.timestamp), BTC_65K);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.NotInitiated.selector, 999));
        IWhitespacePriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, 999));
    }

    /// @dev Only the price router may register an order.
    function test_getPriceRejectsNonRouter() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.NotRouter.selector, address(0xBAD)));
        upkeep.getPrice(1, 0, IWhitespacePriceUpKeep.OrderType.MARKET_OPEN, block.timestamp);
    }

    /// @dev Forwarder registration is `onlyTimelock` (the registry `owner()`), matching the
    ///      vendored upkeep, so the phase-1 runbook's role split still applies.
    function test_registerForwarderRejectsGov() public {
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(IWhitespacePriceUpKeep.NotTimelock.selector, gov));
        IWhitespaceForwarded(address(upkeep)).registerForwarder(address(0x1234));
    }
}

/// @notice The window between the two install transactions, when the verifier and the upkeep
///         disagree about the wire format.
/// @dev    `WhitespaceVerifier` returns a NINE-field payload; `WhitespacePrivatePriceUpKeep` decodes
///         SEVEN. Migrating a live system means one gov transaction lands before the other, so
///         this state exists on chain for at least one block, and "it fails closed" is a claim
///         about a NEGATIVE — exactly the kind that deserves a probe rather than an assertion in
///         a comment. Both halves are driven here, both directions.
///
///         The assertions are deliberately "the call failed AND no position exists" rather than
///         a pinned error payload: the point is not WHICH decoder gave up, it is that no price
///         reaches the callbacks. A pinned selector here would be pinning an accident of the
///         verifier address's high bits.
contract OracleMigrationWindowTest is Test {
    uint256 internal constant K1 = 0xA11CE01;
    uint256 internal constant K2 = 0xA11CE02;
    uint256 internal constant K3 = 0xA11CE03;
    bytes32 internal constant FEED = "BTC/USD";
    int192 internal constant BTC_65K = 65_000e18;

    DeployScript internal deployer;
    OperateScript internal operator;
    SystemDeployer.Deployment internal d;

    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal marketMaker = address(0x33D);
    address internal keeper = address(0x1EE);
    address internal lp = address(0x1B0);
    address internal trader = address(0x7AA);
    address internal guardian = address(0x64A);

    function setUp() public {
        deployer = new DeployScript();
        d = deployer.deployAll(
            SystemDeployer.Roles({
                gov: gov, dev: dev, manager: manager, owner: address(this), marketMaker: marketMaker
            })
        );
        operator = new OperateScript();

        OperateScript.Config memory c = _config();
        vm.prank(gov);           uint16 pairIndex = operator.addMarket(c);
        vm.prank(manager);       operator.setMaxOi(c, pairIndex);
        vm.prank(gov);           operator.approveVaultAllowance(c);
        vm.prank(gov);           operator.authoriseSigner(c);
        vm.prank(address(this)); operator.authoriseForwarder(c);
        vm.prank(gov);           operator.registerUpkeep(c);
        vm.prank(address(this)); operator.mintToLp(c);
        vm.prank(lp);            uint32 settlementId = operator.requestLpDeposit(c);
        vm.prank(gov);           operator.settle(c);
        vm.prank(lp);            operator.claimLpDeposit(c, settlementId);

        USDW(d.collateral).mint(trader, 10_000e6);
        vm.prank(trader);
        IERC20(d.collateral).approve(d.tradingStorage, type(uint256).max);
    }

    function _config() internal view returns (OperateScript.Config memory) {
        return OperateScript.Config({
            registry: d.registry, usdw: d.collateral, pairsStorage: d.pairsStorage,
            vault: d.vault, verifier: d.verifier, priceUpKeep: d.priceUpKeep,
            signer: vm.addr(K1), keeper: keeper, lp: lp, lpAmount: 100_000e6
        });
    }

    function _oracleConfig() internal view returns (OperateScript.OracleConfig memory) {
        address[] memory signers = new address[](3);
        signers[0] = vm.addr(K1);
        signers[1] = vm.addr(K2);
        signers[2] = vm.addr(K3);
        return OperateScript.OracleConfig({
            registry: d.registry, signers: signers, threshold: 3, guardian: guardian,
            keeper: keeper, maxAge: 10, maxDeviationBps: 500
        });
    }

    function _openMarketTrade() internal returns (uint256 orderId, uint32 timestamp) {
        vm.recordLogs();
        vm.prank(trader);
        IWhitespaceTrading(d.trading).openTrade(
            IWhitespaceTradingStorage.Trade({
                collateral: 1000e6, openPrice: uint192(uint256(int256(BTC_65K))), tp: 0, sl: 0,
                trader: trader, leverage: 1000, pairIndex: 0, index: 0, buy: true, isDayTrade: false
            }),
            IWhitespaceTradingStorage.BuilderFee({builder: address(0), builderFee: 0}),
            IWhitespaceTradingStorage.OpenOrderType.MARKET,
            100
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("PriceRequestedV2(uint256,uint8,bytes32,uint256)");
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics.length > 1 && logs[i - 1].topics[0] == sig) {
                (,, uint256 ts) = abi.decode(logs[i - 1].data, (uint8, bytes32, uint256));
                return (uint256(logs[i - 1].topics[1]), uint32(ts));
            }
        }
        revert("no PriceRequestedV2 emitted");
    }

    function _openCollateral() internal view returns (uint256 collateral) {
        (collateral,,,,,,,,,) = IWhitespaceTradingStorage(d.tradingStorage).openTrades(trader, 0, 0);
    }

    /// @dev Verifier swapped, upkeep not yet. The vendored upkeep asks the hardened verifier for
    ///      a report and gets nine fields back where it expects seven.
    function test_hardenedVerifierWithVendoredUpkeepFailsClosed() public {
        vm.prank(gov);
        address v = operator.installHardenedVerifier(_oracleConfig());

        (uint256 orderId, uint32 timestamp) = _openMarketTrade();
        bytes memory report = ReportLib.signedReport(
            ReportLib.btcReport(v, FEED, timestamp, BTC_65K), ReportLib.keys3(K1, K2, K3)
        );

        vm.prank(keeper);
        (bool ok,) = d.priceUpKeep.call(
            abi.encodeCall(IWhitespacePriceUpKeep.performUpkeep, (abi.encode(report, orderId)))
        );

        assertFalse(ok, "a nine-field report must not be delivered through the seven-field upkeep");
        assertEq(_openCollateral(), 0, "no position may be opened in the migration window");
    }

    /// @dev Upkeep swapped, verifier not yet. The hardened upkeep hands the vendored verifier an
    ///      `abi.encode(bytes, bytes[])` blob where it expects `abi.encode(bytes, r, s, v)`.
    function test_vendoredVerifierWithHardenedUpkeepFailsClosed() public {
        vm.prank(gov);
        address u = operator.installHardenedUpkeep(_oracleConfig());
        vm.prank(address(this));
        operator.authoriseHardenedForwarder(_oracleConfig());

        (uint256 orderId, uint32 timestamp) = _openMarketTrade();
        bytes memory report = ReportLib.signedReport(
            ReportLib.btcReport(d.verifier, FEED, timestamp, BTC_65K), ReportLib.keys3(K1, K2, K3)
        );

        vm.prank(keeper);
        (bool ok,) = u.call(
            abi.encodeCall(IWhitespacePriceUpKeep.performUpkeep, (abi.encode(report, orderId)))
        );

        assertFalse(ok, "a threshold report must not be delivered through the single-signer verifier");
        assertEq(_openCollateral(), 0, "no position may be opened in the migration window");
    }

    /// @dev And the old single-signer report format is equally undeliverable once the hardened
    ///      verifier is in place — an attacker cannot fall back to the weaker path.
    function test_legacySingleSignatureReportIsUndeliverable() public {
        OperateScript.OracleConfig memory oc = _oracleConfig();
        vm.prank(gov);           address v = operator.installHardenedVerifier(oc);
        vm.prank(gov);           address u = operator.installHardenedUpkeep(oc);
        vm.prank(address(this)); operator.authoriseHardenedForwarder(oc);

        (uint256 orderId, uint32 timestamp) = _openMarketTrade();

        // The phase-1 wire format: seven fields, one signature, encoded as (bytes, r, s, v).
        bytes memory legacyData =
            abi.encode(FEED, timestamp, BTC_65K, BTC_65K - 1e18, BTC_65K + 1e18, true, false);
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(K1, ReportLib.digest(legacyData));
        bytes memory legacyReport = abi.encode(legacyData, sr, ss, sv);

        vm.prank(keeper);
        (bool ok,) = u.call(
            abi.encodeCall(IWhitespacePriceUpKeep.performUpkeep, (abi.encode(legacyReport, orderId)))
        );

        assertFalse(ok, "the retired single-signature format must not be accepted");
        assertEq(_openCollateral(), 0);
        assertTrue(v != address(0));
    }
}
