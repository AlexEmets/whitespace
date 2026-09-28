// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TestnetFixture} from "../helpers/TestnetFixture.sol";
import {DeployScript, SystemDeployer} from "../../script/Deploy.s.sol";
import {DeployTestnetScript} from "../../script/DeployTestnet.s.sol";
import {OstiumVault} from "../../src/vendor/ostium/OstiumVault.sol";
import {OstiumPairInfos} from "../../src/vendor/ostium/OstiumPairInfos.sol";
import {WhitespacePriceUpKeep} from "../../src/oracle/WhitespacePriceUpKeep.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPairsStorage} from "../../src/vendor/ostium/interfaces/IOstiumPairsStorage.sol";
import {IOstiumPairInfos} from "../../src/vendor/ostium/interfaces/IOstiumPairInfos.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumPriceUpKeep} from "../../src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol";

/// @notice The testnet deploy script produces exactly the system the spec describes, every market
///         on it trades, liquidation works end to end, and re-running configuration changes nothing.
contract DeployTestnetTest is TestnetFixture {
    address internal trader = address(0x7AA);

    function setUp() public {
        _deployTestnet();
        _fundTrader(trader, 100_000e6);
    }

    // -------------------------------------------------------------------------------------
    // Wiring
    // -------------------------------------------------------------------------------------

    function test_registryResolvesEveryComponentIncludingTheTradesUpKeep() public view {
        IOstiumRegistry r = IOstiumRegistry(d.registry);
        bytes32[9] memory names = [
            bytes32("tradingStorage"), "pairsStorage", "pairInfos", "trading", "callbacks", "vault",
            "openPnl", "priceRouter", "tradesUpKeep"
        ];
        for (uint256 i = 0; i < names.length; i++) {
            assertGt(r.getContractAddress(names[i]).code.length, 0, string.concat("no code behind ", string(abi.encodePacked(names[i]))));
        }
        assertEq(r.gov(), gov, "gov");
        assertEq(r.manager(), manager, "manager");
        assertEq(r.dev(), dev, "dev");
    }

    function test_theHardenedOracleIsInstalledWithThreeOfFiveSigners() public view {
        assertEq(verifier.threshold(), THRESHOLD, "k");
        assertEq(verifier.signerCount(), 5, "N");
        address[] memory signers = _signerAddresses();
        for (uint256 i = 0; i < signers.length; i++) {
            assertTrue(verifier.isAuthorizedSigner(signers[i]), "every signer authorised");
        }
        assertEq(upkeep.maxAge(), MAX_AGE, "maxAge");
        assertEq(upkeep.maxDeviationBps(), MAX_DEVIATION_BPS, "maxDeviationBps");
        assertEq(upkeep.guardian(), guardian, "guardian");
        assertTrue(upkeep.isForwarder(keeper), "keeper delivers prices");
        assertFalse(upkeep.isForwarder(liquidatorA), "a liquidator does not deliver prices");
    }

    function test_everyMarketResolvesItsPriceThroughTheOneHardenedUpkeep() public view {
        IOstiumRegistry r = IOstiumRegistry(d.registry);
        bytes32[4] memory keys =
            [bytes32("BTC/USDPriceUpkeep"), "ETH/USDPriceUpkeep", "SOL/USDPriceUpkeep", "WBT/USDPriceUpkeep"];
        for (uint256 i = 0; i < keys.length; i++) {
            assertEq(r.getContractAddress(keys[i]), address(upkeep), "one upkeep serves every feed");
        }
    }

    function test_bothLiquidatorsAndNobodyElseMayTriggerAutomation() public view {
        assertTrue(tradesUpKeep.isForwarder(liquidatorA), "liquidator A");
        assertTrue(tradesUpKeep.isForwarder(liquidatorB), "liquidator B");
        assertFalse(tradesUpKeep.isForwarder(keeper), "keeper");
        assertFalse(tradesUpKeep.isForwarder(gov), "gov");
        assertFalse(tradesUpKeep.isForwarder(trader), "trader");
    }

    function test_marketOrdersTimeoutIsElevenBlocksAndTriggerTimeoutUnchanged() public view {
        assertEq(IOstiumTrading(d.trading).marketOrdersTimeout(), 11, "marketOrdersTimeout");
        assertEq(IOstiumTrading(d.trading).triggerTimeout(), 30, "triggerTimeout");
    }

    function test_vaultIsSeededAndSettlesHourly() public view {
        OstiumVault v = OstiumVault(d.vault);
        assertEq(v.maxSettlementInterval(), 1 hours, "maxSettlementInterval");
        assertEq(v.currentBalance(), LP_AMOUNT, "vault liquidity");
        assertGt(v.balanceOf(lp), 0, "the LP holds its claimed shares");
        assertEq(v.balanceOf(d.vault), 0, "no shares left in escrow");
        assertGt(IERC20(d.collateral).allowance(d.callbacks, d.vault), 0, "callbacks can pay the vault");
    }

    // -------------------------------------------------------------------------------------
    // Markets
    // -------------------------------------------------------------------------------------

    function test_listsExactlyTheFourSpecifiedMarketsInOrder() public view {
        IOstiumPairsStorage ps = IOstiumPairsStorage(d.pairsStorage);
        DeployTestnetScript.MarketSpec[] memory specs = script.testnetMarkets();
        assertEq(ps.pairsCount(), specs.length, "pair count");
        assertEq(ps.groupsCount(), 1, "one group");
        assertEq(ps.feesCount(), 1, "one fee tier");

        bytes32[4] memory from = [bytes32("BTC"), "ETH", "SOL", "WBT"];
        for (uint16 i = 0; i < specs.length; i++) {
            (bytes32 f, bytes32 t, bytes32 feed,,, uint32 maxLev, uint16 groupIndex, uint16 feeIndex,) = ps.pairs(i);
            assertEq(f, from[i], "from");
            assertEq(t, bytes32("USD"), "to");
            assertEq(feed, _feedOf(i), "feed");
            assertEq(maxLev, specs[i].maxLeverage, "maxLeverage");
            assertEq(groupIndex, 0, "group");
            assertEq(feeIndex, 0, "fee tier");
            assertEq(IOstiumTradingStorage(d.tradingStorage).openInterest(i, 2), specs[i].maxOi, "max OI");
        }
    }

    function test_theSpecifiedLeverageAndOpenInterestPerMarket() public view {
        DeployTestnetScript.MarketSpec[] memory m = script.testnetMarkets();
        assertEq(m[BTC].maxLeverage, 10_000, "BTC 100x");
        assertEq(m[ETH].maxLeverage, 10_000, "ETH 100x");
        assertEq(m[SOL].maxLeverage, 10_000, "SOL 100x");
        assertEq(m[WBT].maxLeverage, 2_500, "WBT 25x");
        assertEq(m[BTC].maxOi, 1_000_000e6, "BTC OI");
        assertEq(m[WBT].maxOi, 100_000e6, "WBT OI");
    }

    function test_everyMarketChargesTheSpecifiedOpeningFees() public {
        for (uint16 i = 0; i < 4; i++) {
            (uint32 maker, uint32 taker, uint32 usage, uint16 util, uint16 makerMaxLev, uint8 vaultPct) =
                IOstiumPairInfos(d.pairInfos).pairOpeningFees(i);
            assertEq(maker, 30_000, "maker 0.03%");
            assertEq(taker, 60_000, "taker 0.06%");
            assertEq(usage, 0, "no usage fee");
            assertEq(util, 8_000, "utilisation threshold");
            assertEq(makerMaxLev, 2_000, "maker up to 20x");
            assertEq(vaultPct, 50, "half of every fee to the vault");
        }
    }

    function test_everyMarketHasFundingCappedAtOneHundredPercentAYear() public {
        for (uint16 i = 0; i < 4; i++) {
            (,,, int64 inflection, uint64 maxPerBlock, uint64 spring,, uint16 pos, uint16 neg, uint16 up, uint16 down,) =
                IOstiumPairInfos(d.pairInfos).pairFundingFees(i);
            assertEq(inflection, 0, "no inflection offset");
            assertEq(maxPerBlock, 31_709_791_983, "1e18 / 31,536,000 blocks");
            assertEq(spring, 1e14, "spring factor");
            assertEq(pos, 100, "hill pos scale");
            assertEq(neg, 100, "hill neg scale");
            assertEq(up, 200_00, "sign flip converges twice as fast");
            assertEq(down, 100_00, "down scale");
            // 100%/year at 1 s/block, within one part in 1e10.
            assertApproxEqRel(uint256(maxPerBlock) * 31_536_000, 1e18, 1e8, "annualised cap");
        }
    }

    function test_everyMarketCarriesAOneAndAHalfPercentBrokerPremium() public view {
        for (uint16 i = 0; i < 4; i++) {
            (,, int256 lastLongPure, uint256 premium, uint64 maxPerBlock, uint32 lastUpdate, bool negAllowed) =
                OstiumPairInfos(d.pairInfos).pairRolloverFeesV2(i);
            assertEq(lastLongPure, 0, "no directional rollover");
            assertEq(premium, 475_646_879, "1.5% / year");
            assertEq(maxPerBlock, 951_293_758, "cap = 2x premium");
            assertGt(lastUpdate, 0, "rollover accrual started");
            assertFalse(negAllowed, "never pays holders");
        }
    }

    function test_priceImpactIsLiveOnEveryMarket() public {
        uint256[4] memory thresholds = [uint256(50_000e18), 50_000e18, 50_000e18, 10_000e18];
        uint256[4] memory ks = [uint256(2e18), 2e18, 2e18, 1e19];
        for (uint16 i = 0; i < 4; i++) {
            (uint256 thr, uint128 decay, uint256 k) = IOstiumPairInfos(d.pairInfos).pairDynamicSpreadParams(i);
            assertEq(thr, thresholds[i], "net volume threshold");
            assertEq(decay, 1e15, "decay rate");
            assertEq(k, ks[i], "priceImpactK");
        }
    }

    // -------------------------------------------------------------------------------------
    // It trades
    // -------------------------------------------------------------------------------------

    function test_everyMarketOpensAndClosesAPosition() public {
        for (uint16 i = 0; i < 4; i++) {
            _open(trader, i, 1_000e6, 1_000, true);
            assertEq(_openTrade(trader, i, 0).leverage, 1_000, "position opened");

            vm.recordLogs();
            vm.prank(trader);
            IOstiumTrading(d.trading).closeTradeMarket(i, 0, 0, uint192(uint256(int256(_basePrice(i)))), 100);
            (uint256 orderId, uint32 ts) = _lastPriceRequest();
            _deliver(orderId, _report(i, ts, _basePrice(i)));
            assertEq(_openTrade(trader, i, 0).leverage, 0, "position closed");
        }
    }

    /// @notice The opening fee is charged at the spec rate and split half to the vault.
    function test_openingFeeIsChargedAndSplitHalfToTheVault() public {
        uint256 devFeesBefore = IOstiumTradingStorage(d.tradingStorage).devFees();
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 devFee = IOstiumTradingStorage(d.tradingStorage).devFees() - devFeesBefore;
        // ~10,000 notional at the 0.06% taker rate is ~6 USDW; the dev half is ~3. The $1 oracle
        // fee accrues to devFees as well.
        assertApproxEqRel(devFee, 3e6 + 1e6, 0.01e18, "dev half of a 0.06% taker fee plus the oracle fee");
    }

    /// @notice Above the net-volume threshold a larger trade fills at a worse price than a small
    ///         one — the quote the terminal shows is real.
    function test_aLargeTradeFillsWorseThanASmallOne() public {
        address small = address(0x5A1);
        address large = address(0x1A2);
        _fundTrader(small, 1_000_000e6);
        _fundTrader(large, 1_000_000e6);

        _open(small, BTC, 100e6, 1_000, true); // 1k notional, under the threshold
        uint256 snapshot = vm.snapshotState();
        (uint256 orderId, uint32 ts) = _requestOpen(_trade(large, BTC, 10_000e6, 5_000, true, 0), 500); // 500k
        _deliver(orderId, _report(BTC, ts, _basePrice(BTC)));

        uint192 smallFill = _openTrade(small, BTC, 0).openPrice;
        uint192 largeFill = _openTrade(large, BTC, 0).openPrice;
        assertGt(largeFill, smallFill, "a long pays more the more it buys");
        vm.revertToState(snapshot);
    }

    // -------------------------------------------------------------------------------------
    // The market-order window
    // -------------------------------------------------------------------------------------

    /// @notice At every block after the request an order is fillable or refundable — never
    ///         neither (a dead window), never both (a free option).
    function test_everyBlockAfterARequestIsExactlyOneOfFillableOrRefundable() public {
        (uint256 orderId, uint32 ts) = _requestOpen(_trade(trader, BTC, 1_000e6, 1_000, true, 0), 100);

        for (uint256 n = 1; n <= 20; n++) {
            uint256 snapshot = vm.snapshotState();
            _advance(n);

            bool fillable = _tryDeliver(orderId, _report(BTC, ts, _basePrice(BTC)));
            vm.revertToState(snapshot);
            snapshot = vm.snapshotState();
            _advance(n);

            vm.prank(trader);
            (bool refundable,) =
                d.trading.call(abi.encodeCall(IOstiumTrading.openTradeMarketTimeout, (orderId)));

            assertTrue(fillable != refundable, string.concat("block +", vm.toString(n), " is not exactly one"));
            assertEq(fillable, n <= MAX_AGE, "fillable exactly while the report is within maxAge");
            vm.revertToState(snapshot);
        }
    }

    function _tryDeliver(uint256 orderId, bytes memory report) internal returns (bool ok) {
        vm.prank(keeper);
        (ok,) = address(upkeep).call(abi.encodeCall(IOstiumPriceUpKeep.performUpkeep, (abi.encode(report, orderId))));
    }

    // -------------------------------------------------------------------------------------
    // Liquidation, end to end
    // -------------------------------------------------------------------------------------

    function test_aLiquidatorLiquidatesAnUnderwaterPositionEndToEnd() public {
        _open(trader, BTC, 1_000e6, 5_000, true); // 50x long at 65,000
        uint256 vaultBefore = IERC20(d.collateral).balanceOf(d.vault);
        uint256 traderBefore = IERC20(d.collateral).balanceOf(trader);

        (uint256 orderId, uint32 ts) = _trigger(liquidatorA, trader, BTC, 0, IOstiumTradingStorage.LimitOrder.LIQ);
        _deliver(orderId, _report(BTC, ts, 63_500e18)); // -2.3% at 50x is past the margin

        assertEq(_openTrade(trader, BTC, 0).leverage, 0, "position liquidated");
        assertEq(IERC20(d.collateral).balanceOf(trader), traderBefore, "the trader is paid nothing");
        assertGt(IERC20(d.collateral).balanceOf(d.vault), vaultBefore, "the vault receives what is left");
    }

    function test_aHealthyPositionSurvivesALiquidationTrigger() public {
        _open(trader, BTC, 1_000e6, 5_000, true);
        (uint256 orderId, uint32 ts) = _trigger(liquidatorB, trader, BTC, 0, IOstiumTradingStorage.LimitOrder.LIQ);
        _deliver(orderId, _report(BTC, ts, _basePrice(BTC)));
        assertEq(_openTrade(trader, BTC, 0).leverage, 5_000, "not liquidated at its own entry");
    }

    // -------------------------------------------------------------------------------------
    // Re-running
    // -------------------------------------------------------------------------------------

    /// @notice A second `configureTestnet()` over the finished system emits no event from any
    ///         system contract — every step saw its work already done.
    function test_reRunningConfigurationChangesNothing() public {
        vm.setEnv("REGISTRY_ADDRESS", vm.toString(d.registry));
        uint256 supplyBefore = IERC20(d.collateral).totalSupply();

        vm.recordLogs();
        script.configureTestnet();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 0, "a replay must not write anything");
        assertEq(IERC20(d.collateral).totalSupply(), supplyBefore, "a replay must not mint");
    }

    /// @notice `configureTestnet()` turns a bare `DeployScript` core — 30-block timeout, no
    ///         oracle, no markets — into the same system.
    function test_configureTestnetCompletesACoreDeployedByTheOriginalScript() public {
        DeployScript core = new DeployScript();
        SystemDeployer.Deployment memory bare = core.deployAll(
            SystemDeployer.Roles({gov: gov, dev: dev, manager: manager, owner: owner, marketMaker: marketMaker})
        );
        assertEq(IOstiumTrading(bare.trading).marketOrdersTimeout(), 30, "precondition");

        vm.setEnv("REGISTRY_ADDRESS", vm.toString(bare.registry));
        DeployTestnetScript fresh = new DeployTestnetScript();
        fresh.configureTestnet();

        assertEq(IOstiumTrading(bare.trading).marketOrdersTimeout(), 11, "timeout aligned");
        assertEq(IOstiumPairsStorage(bare.pairsStorage).pairsCount(), 4, "markets listed");
        assertEq(OstiumVault(bare.vault).currentBalance(), LP_AMOUNT, "vault seeded");
        IOstiumRegistry(bare.registry).getContractAddress("tradesUpKeep");
    }

    function test_refusesAnyChainButTestnetAndAnvil() public {
        DeployTestnetScript fresh = new DeployTestnetScript();
        vm.chainId(1875);
        vm.expectRevert("unsupported chain");
        fresh.deployTestnet();
        vm.chainId(1);
        vm.expectRevert("unsupported chain");
        fresh.deployTestnet();
    }
}
