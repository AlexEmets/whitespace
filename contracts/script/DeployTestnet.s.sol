// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemDeployer} from "./Deploy.s.sol";
import {OperateScript} from "./Operate.s.sol";
import {OstiumVault} from "../src/vendor/ostium/OstiumVault.sol";
import {OstiumPairInfos} from "../src/vendor/ostium/OstiumPairInfos.sol";
import {IOstiumRegistry} from "../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPairsStorage} from "../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {IOstiumPairInfos} from "../src/vendor/ostium/interfaces/IOstiumPairInfos.sol";
import {IOstiumTrading} from "../src/vendor/ostium/interfaces/IOstiumTrading.sol";

/// @notice The whole testnet system from nothing, in one run: the vendored core, the hardened
///         k-of-N oracle, `OstiumTradesUpKeep` with its forwarders, every market with real
///         economics, and a seeded LP vault.
///
/// @dev    Exists because chain 1874 is being redeployed rather than migrated (the registry gov
///         key of the first deployment is lost — see
///         `docs/superpowers/specs/2026-09-28-testnet-perfect-design.md` §1). The first deployment
///         was assembled by four separate `OperateScript` entry points run weeks apart; this
///         script reuses those same idempotent steps in one recorded order, so the redeploy is a
///         rehearsal of how a mainnet deploy would run rather than a reconstruction of history.
///
///         Two entry points:
///           - `deployTestnet()`  deploys the core, then configures it.
///           - `configureTestnet()` configures an already-deployed core (REGISTRY_ADDRESS) and is
///             safe to re-run: a deploy that dies half-way through configuration is resumed with
///             it, and every step returns early when its work is already done.
///
///         Every economic value lives in `testnetMarkets()` and is pinned by
///         `test/integration/DeployTestnet.t.sol`.
contract DeployTestnetScript is SystemDeployer, OperateScript {
    // ---------------------------------------------------------------------------------------
    // System-wide parameters
    // ---------------------------------------------------------------------------------------

    /// @dev Blocks before a trader may reclaim an unfilled market order. A report is deliverable
    ///      while `block.timestamp <= orderTimestamp + maxAge` (10 s), and a reclaim is allowed
    ///      once `block.number >= orderBlock + marketOrdersTimeout` (`OstiumTrading.sol:673`). At
    ///      1 s/block — fixed on the OP Stack sequencer — 11 is the one value where every block
    ///      after the request is exactly one of fillable or refundable:
    ///        - above 11, orders sit in a dead window (the original 30 left 19 blocks:
    ///          `KeeperCensorship.t.sol::test_measureTheWindowWhereAnOrderIsNeitherFillableNorRefundable`);
    ///        - below 11, a trader could watch the price move after requesting and reclaim while
    ///          the order is still fillable — a free option against the vault.
    uint16 internal constant TESTNET_MARKET_ORDERS_TIMEOUT = 11;

    /// @dev Anyone may trigger a vault settlement once this has elapsed since the last one
    ///      (`OstiumVault.tryNewSettlement`). The vendored default is 24 h, which makes an LP
    ///      deposit un-testable on a working day; one hour is inside the contract's 10 min–3 day
    ///      bounds.
    uint32 internal constant TESTNET_MAX_SETTLEMENT_INTERVAL = 1 hours;

    /// @dev At 1 s/block. The vendored per-block caps were written for Arbitrum's ~0.25 s blocks,
    ///      so an "annual" figure in a vendored comment is ~4x too high here.
    uint256 internal constant BLOCKS_PER_YEAR = 31_536_000;

    /// @notice Every economic parameter of one market.
    /// @param name        `<FROM>/<TO>`; also the feed id and the oracle name (see `addMarketFor`).
    /// @param maxLeverage PRECISION_2.
    /// @param maxOi       PRECISION_6 open-interest ceiling.
    struct MarketSpec {
        string name;
        uint32 maxLeverage;
        uint256 maxOi;
        IOstiumPairInfos.PairOpeningFees openingFees;
        IOstiumPairInfos.PairFundingFeesV2 funding;
        IOstiumPairInfos.PairRolloverFeesV2 rollover;
        IOstiumPairInfos.DynamicSpreadParams spread;
    }

    /// @notice Addresses the configuration needs beyond the core deployment.
    struct TestnetConfig {
        address registry;
        address collateral;
        address vault;
        address[] signers;
        uint256 threshold;
        address guardian;
        address keeper;
        address[] liquidators;
        address lp;
        uint256 lpAmount;
    }

    // ---------------------------------------------------------------------------------------
    // Market economics
    // ---------------------------------------------------------------------------------------

    /// @dev Taker 0.06%, maker 0.03% (maker = a trade that reduces the OI imbalance, up to 20x),
    ///      half of each fee to the vault. PRECISION_6 percent: 60_000 == 0.06%.
    function _openingFees() internal pure returns (IOstiumPairInfos.PairOpeningFees memory) {
        return IOstiumPairInfos.PairOpeningFees({
            makerFeeP: 30_000,
            takerFeeP: 60_000,
            usageFeeP: 0,
            utilizationThresholdP: 8_000,
            makerMaxLeverage: 2_000,
            vaultFeePercent: 50
        });
    }

    /// @dev Funding caps at 100%/year at full imbalance (1e18 / BLOCKS_PER_YEAR per block) and
    ///      approaches its target with a time constant of 1/springFactor = 10,000 blocks
    ///      (~2.8 h); twice as fast when the sign flips (`sFactorUpScaleP` 200%).
    function _funding() internal pure returns (IOstiumPairInfos.PairFundingFeesV2 memory f) {
        f.maxFundingFeePerBlock = uint64(1e18 / BLOCKS_PER_YEAR);
        f.springFactor = 1e14;
        f.hillPosScale = 100;
        f.hillNegScale = 100;
        f.sFactorUpScaleP = 200_00;
        f.sFactorDownScaleP = 100_00;
    }

    /// @dev A flat 1.5%/year holding cost on both sides (`brokerPremium`), paid to the vault.
    ///      `brokerPremium` is capped by the vendored `MAX_BROKER_PREMIUM_PER_BLOCK`, which is
    ///      ~3%/year at 1 s/block; half of it is used.
    function _rollover() internal pure returns (IOstiumPairInfos.PairRolloverFeesV2 memory r) {
        r.brokerPremium = uint256(15e15) / BLOCKS_PER_YEAR;
        r.maxRolloverFeePerBlock = uint64(2 * r.brokerPremium);
    }

    /// @dev Size-dependent price impact. Below `netVolThreshold` of recent one-sided volume a
    ///      trade pays only the half-spread; above it, impact grows linearly with size:
    ///      `K * size/2 * 100 / 1e27` percent. K = 2e18 costs a $1M trade 0.1% on top of the
    ///      spread. Recent volume decays with a rate of 1e15/s (half-life ~11.5 min).
    function _spread(uint256 netVolThreshold, uint256 priceImpactK)
        internal
        pure
        returns (IOstiumPairInfos.DynamicSpreadParams memory)
    {
        return IOstiumPairInfos.DynamicSpreadParams({
            netVolThreshold: netVolThreshold,
            decayRate: 1e15,
            priceImpactK: priceImpactK
        });
    }

    /// @notice The markets the testnet lists, in pair-index order.
    /// @dev WBT/USD is priced from WhiteBIT alone (two books), so it gets a quarter of the
    ///      leverage, a tenth of the open interest and five times the impact of the majors.
    function testnetMarkets() public pure returns (MarketSpec[] memory m) {
        m = new MarketSpec[](4);
        m[0] = MarketSpec("BTC/USD", 10_000, 1_000_000e6, _openingFees(), _funding(), _rollover(), _spread(50_000e18, 2e18));
        m[1] = MarketSpec("ETH/USD", 10_000, 1_000_000e6, _openingFees(), _funding(), _rollover(), _spread(50_000e18, 2e18));
        m[2] = MarketSpec("SOL/USD", 10_000, 1_000_000e6, _openingFees(), _funding(), _rollover(), _spread(50_000e18, 2e18));
        m[3] = MarketSpec("WBT/USD", 2_500, 100_000e6, _openingFees(), _funding(), _rollover(), _spread(10_000e18, 1e19));
    }

    // ---------------------------------------------------------------------------------------
    // Configuration steps — one sender role each, each idempotent
    // ---------------------------------------------------------------------------------------

    /// @notice Lists the one group and the one fee tier every market shares.
    /// @dev Caller must be `registry.gov()`. Same values `addMarket` creates for BTC/USD.
    function ensureGroupAndFee(address registry) public {
        IOstiumPairsStorage ps = IOstiumPairsStorage(IOstiumRegistry(registry).getContractAddress("pairsStorage"));
        if (ps.groupsCount() == 0) {
            _relay(msg.sender);
            ps.addGroup(
                IOstiumPairsStorage.Group({
                    name: GROUP_NAME,
                    minLeverage: GROUP_MIN_LEVERAGE,
                    maxLeverage: GROUP_MAX_LEVERAGE,
                    maxCollateralP: GROUP_MAX_COLLATERAL_P
                })
            );
        }
        if (ps.feesCount() == 0) {
            _relay(msg.sender);
            ps.addFee(
                IOstiumPairsStorage.Fee({
                    name: FEE_NAME,
                    minLevPos: FEE_MIN_LEV_POS,
                    oracleFee: FEE_ORACLE_FEE,
                    liqFeeP: FEE_LIQ_FEE_P
                })
            );
        }
    }

    /// @notice Opening fees, funding and rollover for one listed market.
    /// @dev Caller must be `registry.gov()`. Each of the three is compared before it is written.
    function configureMarketEconomics(address registry, uint16 pairIndex, MarketSpec memory m) public {
        IOstiumPairInfos pi = IOstiumPairInfos(IOstiumRegistry(registry).getContractAddress("pairInfos"));

        (uint32 makerFeeP, uint32 takerFeeP, uint32 usageFeeP, uint16 utilP, uint16 makerMaxLev, uint8 vaultFeeP) =
            pi.pairOpeningFees(pairIndex);
        IOstiumPairInfos.PairOpeningFees memory f = m.openingFees;
        if (
            makerFeeP != f.makerFeeP || takerFeeP != f.takerFeeP || usageFeeP != f.usageFeeP
                || utilP != f.utilizationThresholdP || makerMaxLev != f.makerMaxLeverage || vaultFeeP != f.vaultFeePercent
        ) {
            _relay(msg.sender);
            pi.setPairOpeningFees(pairIndex, f);
        }

        (,,, int64 hillInflectionPoint, uint64 maxFundingFeePerBlock, uint64 springFactor,, uint16 hillPos, uint16 hillNeg, uint16 up, uint16 down,)
        = pi.pairFundingFees(pairIndex);
        IOstiumPairInfos.PairFundingFeesV2 memory fu = m.funding;
        if (
            hillInflectionPoint != fu.hillInflectionPoint || maxFundingFeePerBlock != fu.maxFundingFeePerBlock
                || springFactor != fu.springFactor || hillPos != fu.hillPosScale || hillNeg != fu.hillNegScale
                || up != fu.sFactorUpScaleP || down != fu.sFactorDownScaleP
        ) {
            _relay(msg.sender);
            pi.setPairFundingFees(pairIndex, fu);
        }

        (,, int256 lastLongPure, uint256 brokerPremium, uint64 maxRollover, uint32 lastUpdateBlock, bool negAllowed) =
            OstiumPairInfos(address(pi)).pairRolloverFeesV2(pairIndex); // not on the interface
        IOstiumPairInfos.PairRolloverFeesV2 memory r = m.rollover;
        if (
            lastUpdateBlock == 0 || lastLongPure != r.lastLongPure || brokerPremium != r.brokerPremium
                || maxRollover != r.maxRolloverFeePerBlock || negAllowed != r.isNegativeRolloverAllowed
        ) {
            _relay(msg.sender);
            pi.setPairRolloverFees(pairIndex, r);
        }
    }

    /// @notice Size-dependent price impact for one listed market.
    /// @dev Caller must be `registry.manager()` (or gov): `setPairDynamicSpreadParams` is
    ///      `onlyGovOrManager`, and it is the manager's day-to-day tuning knob.
    function configureMarketSpread(address registry, uint16 pairIndex, MarketSpec memory m) public {
        IOstiumPairInfos pi = IOstiumPairInfos(IOstiumRegistry(registry).getContractAddress("pairInfos"));
        (uint256 thr, uint128 decay, uint256 k) = pi.pairDynamicSpreadParams(pairIndex);
        if (thr == m.spread.netVolThreshold && decay == m.spread.decayRate && k == m.spread.priceImpactK) return;
        _relay(msg.sender);
        pi.setPairDynamicSpreadParams(pairIndex, m.spread);
    }

    /// @notice Aligns the market-order timeout with the oracle's `maxAge`.
    /// @dev Caller must be `registry.gov()`. Needed by `configureTestnet()` on a core deployed by
    ///      `DeployScript` (30 blocks); a core from `deployTestnet()` already has the right value.
    function alignMarketOrdersTimeout(address registry) public {
        IOstiumTrading trading = IOstiumTrading(IOstiumRegistry(registry).getContractAddress("trading"));
        if (trading.marketOrdersTimeout() == TESTNET_MARKET_ORDERS_TIMEOUT) return;
        _relay(msg.sender);
        trading.setMarketOrdersTimeout(TESTNET_MARKET_ORDERS_TIMEOUT);
    }

    /// @notice Shortens the vault's fallback settlement interval to one hour.
    /// @dev Caller must be `registry.gov()`.
    function configureVaultSettlement(address vault) public {
        OstiumVault v = OstiumVault(vault);
        if (v.maxSettlementInterval() == TESTNET_MAX_SETTLEMENT_INTERVAL) return;
        _relay(msg.sender);
        v.updateMaxSettlementInterval(TESTNET_MAX_SETTLEMENT_INTERVAL);
    }

    function _oracleConfigOf(TestnetConfig memory c) internal pure returns (OracleConfig memory) {
        return OracleConfig({
            registry: c.registry,
            signers: c.signers,
            threshold: c.threshold,
            guardian: c.guardian,
            keeper: c.keeper,
            maxAge: uint32(DEFAULT_ORACLE_MAX_AGE),
            maxDeviationBps: uint16(DEFAULT_ORACLE_MAX_DEVIATION_BPS)
        });
    }

    function _vaultConfigOf(TestnetConfig memory c) internal pure returns (Config memory v) {
        v.registry = c.registry;
        v.usdw = c.collateral;
        v.vault = c.vault;
        v.lp = c.lp;
        v.lpAmount = c.lpAmount;
    }

    function _marketConfigOf(address registry, MarketSpec memory s) internal pure returns (MarketConfig memory) {
        return MarketConfig({
            registry: registry,
            name: s.name,
            maxLeverage: s.maxLeverage,
            maxOi: s.maxOi,
            groupIndex: 0,
            feeIndex: 0
        });
    }

    /// @notice Every upkeep registry key the listed markets resolve their price through.
    function testnetFeedKeys() public pure returns (bytes32[] memory keys) {
        MarketSpec[] memory markets = testnetMarkets();
        keys = new bytes32[](markets.length);
        for (uint256 i = 0; i < markets.length; i++) {
            keys[i] = _upkeepKey(markets[i].name);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Entry points
    // ---------------------------------------------------------------------------------------

    function _requireTestnetChain() internal view {
        // 31337 is a local anvil rehearsal of exactly this run.
        require(block.chainid == 1874 || block.chainid == 31337, "unsupported chain");
    }

    function _readTestnetConfig(address registry, address collateral, address vault)
        internal
        view
        returns (TestnetConfig memory c)
    {
        c.registry = registry;
        c.collateral = collateral;
        c.vault = vault;
        c.signers = vm.envAddress("ORACLE_SIGNERS", ",");
        c.threshold = vm.envUint("ORACLE_THRESHOLD");
        c.guardian = vm.envAddress("GUARDIAN_ADDRESS");
        c.keeper = vm.envAddress("KEEPER_ADDRESS");
        c.liquidators = vm.envAddress("LIQUIDATOR_ADDRESSES", ",");
        c.lp = vm.addr(vm.envUint("LP_PRIVATE_KEY"));
        c.lpAmount = vm.envUint("LP_AMOUNT");
    }

    /// @notice Deploys the core with the testnet market-order timeout, then configures it.
    /// @dev Keys: DEPLOYER_PRIVATE_KEY (becomes registry and USDW owner), GOV_PRIVATE_KEY,
    ///      MANAGER_PRIVATE_KEY, LP_PRIVATE_KEY. Addresses: DEV_ADDRESS, MARKET_MAKER_ADDRESS,
    ///      ORACLE_SIGNERS, ORACLE_THRESHOLD, GUARDIAN_ADDRESS, KEEPER_ADDRESS,
    ///      LIQUIDATOR_ADDRESSES, LP_AMOUNT.
    function deployTestnet() external returns (Deployment memory d) {
        _requireTestnetChain();
        _broadcasting = true;

        uint256 ownerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 govKey = vm.envUint("GOV_PRIVATE_KEY");
        uint256 managerKey = vm.envUint("MANAGER_PRIVATE_KEY");

        vm.startBroadcast(ownerKey);
        d = _deployAll(
            Roles({
                gov: vm.addr(govKey),
                dev: vm.envAddress("DEV_ADDRESS"),
                manager: vm.addr(managerKey),
                owner: vm.addr(ownerKey),
                marketMaker: vm.envAddress("MARKET_MAKER_ADDRESS")
            }),
            TESTNET_MARKET_ORDERS_TIMEOUT
        );
        vm.stopBroadcast();

        _configure(_readTestnetConfig(d.registry, d.collateral, d.vault), ownerKey, govKey, managerKey);
    }

    /// @notice Configures (or resumes configuring) an already-deployed core at REGISTRY_ADDRESS.
    function configureTestnet() external {
        _requireTestnetChain();
        _broadcasting = true;

        IOstiumRegistry registry = IOstiumRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        _configure(
            _readTestnetConfig(
                address(registry),
                address(OstiumVault(registry.getContractAddress("vault")).asset()),
                registry.getContractAddress("vault")
            ),
            vm.envUint("DEPLOYER_PRIVATE_KEY"),
            vm.envUint("GOV_PRIVATE_KEY"),
            vm.envUint("MANAGER_PRIVATE_KEY")
        );
    }

    /// @dev The recorded order. Oracle first, so every market's upkeep key resolves before the
    ///      market is listed (`Operate.s.sol` phase E explains why the reverse order opens a
    ///      window where `openTrade` reverts `NotFound`).
    function _configure(TestnetConfig memory c, uint256 ownerKey, uint256 govKey, uint256 managerKey) internal {
        OracleConfig memory oc = _oracleConfigOf(c);
        Config memory vc = _vaultConfigOf(c);
        uint256 lpKey = vm.envUint("LP_PRIVATE_KEY");

        vm.startBroadcast(govKey);
        installHardenedVerifier(oc);
        authoriseHardenedSigners(oc);
        installHardenedUpkeep(oc, testnetFeedKeys());
        configureOracleRails(oc);
        alignMarketOrdersTimeout(c.registry);
        approveVaultAllowance(vc);
        configureVaultSettlement(c.vault);
        installTradesUpKeep(LiquidationConfig({registry: c.registry, liquidator: address(0)}));
        ensureGroupAndFee(c.registry);
        vm.stopBroadcast();

        vm.startBroadcast(ownerKey);
        authoriseHardenedForwarder(oc);
        for (uint256 i = 0; i < c.liquidators.length; i++) {
            authoriseLiquidator(LiquidationConfig({registry: c.registry, liquidator: c.liquidators[i]}));
        }
        vm.stopBroadcast();

        MarketSpec[] memory markets = testnetMarkets();
        uint16[] memory pairIndices = new uint16[](markets.length);
        vm.startBroadcast(govKey);
        for (uint256 i = 0; i < markets.length; i++) {
            MarketConfig memory mc = _marketConfigOf(c.registry, markets[i]);
            registerUpkeepFor(mc);
            pairIndices[i] = addMarketFor(mc);
            configureMarketEconomics(c.registry, pairIndices[i], markets[i]);
        }
        vm.stopBroadcast();

        vm.startBroadcast(managerKey);
        for (uint256 i = 0; i < markets.length; i++) {
            setMaxOiFor(_marketConfigOf(c.registry, markets[i]), pairIndices[i]);
            configureMarketSpread(c.registry, pairIndices[i], markets[i]);
        }
        vm.stopBroadcast();

        vm.startBroadcast(ownerKey);
        mintToLp(vc);
        vm.stopBroadcast();

        vm.startBroadcast(lpKey);
        uint32 settlementId = requestLpDeposit(vc);
        vm.stopBroadcast();

        vm.startBroadcast(govKey);
        settle(vc);
        vm.stopBroadcast();

        vm.startBroadcast(lpKey);
        claimLpDeposit(vc, settlementId);
        vm.stopBroadcast();
    }
}
