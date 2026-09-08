// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployScript} from "../../script/Deploy.s.sol";
import {OperateScript} from "../../script/Operate.s.sol";
import {USDW} from "../../src/mocks/USDW.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumPriceUpKeep} from "../../src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol";
import {IOstiumForwarded} from "../../src/vendor/ostium/interfaces/IOstiumForwarded.sol";
import {IOstiumVerifier} from "../../src/vendor/ostium/interfaces/IOstiumVerifier.sol";

/// @notice Proves the complete two-phase price flow end to end on a local chain — open a BTC/USD
///         position, deliver a signed report, close it, deliver a second report — plus the four
///         ways delivery fails. This suite is the gate that authorises spending live gas.
contract TradeLocalTest is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant ROGUE_KEY = 0xBADBAD;
    int192 internal constant BTC_65K = 65000000000000000000000; // $65,000, PRECISION_18

    DeployScript internal deployer;
    OperateScript internal operator;
    DeployScript.Deployment internal d;

    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal marketMaker = address(0x33D);
    address internal keeper = address(0x1EE);
    address internal lp = address(0x1B0);
    address internal trader = address(0x7AA);

    address internal signer; // vm.addr(SIGNER_KEY) — the authorised report signer

    function setUp() public {
        signer = vm.addr(SIGNER_KEY);
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

    /// @dev Mirrors `Operate.t.sol`'s driver: each step under the `vm.prank` its role requires.
    function _configureAll() internal {
        OperateScript.Config memory c = _config();
        _configureMarketOnly();
        vm.prank(address(this)); operator.mintToLp(c);             // USDW owner
        vm.prank(lp);           uint32 settlementId = operator.requestLpDeposit(c);
        vm.prank(gov);          operator.settle(c);
        vm.prank(lp);           operator.claimLpDeposit(c, settlementId);
    }

    /// @dev The market and authorisation steps only — deliberately skips the four vault-seeding
    ///      steps, leaving `currentBalance()` at zero. Used by the silent-cancel test.
    function _configureMarketOnly() internal {
        OperateScript.Config memory c = _config();
        vm.prank(gov);          uint16 pairIndex = operator.addMarket(c);
        vm.prank(manager);      operator.setMaxOi(c, pairIndex);
        vm.prank(gov);          operator.approveVaultAllowance(c);
        vm.prank(gov);          operator.authoriseSigner(c);
        vm.prank(address(this)); operator.authoriseForwarder(c);   // registry owner
        vm.prank(gov);          operator.registerUpkeep(c);
    }

    /// @dev Mirrors `OstiumVerifier.verify` exactly: it recovers over the EIP-191 prefix applied
    ///      to keccak256(reportData). Getting this wrong makes every delivery revert
    ///      NotAuthorizedSigner with a garbage recovered address, which is a confusing symptom.
    function _buildReport(bytes32 feedId, uint32 timestamp, int192 price, uint256 signingKey)
        internal
        view
        returns (bytes memory signedReport)
    {
        bytes memory reportData =
            abi.encode(feedId, timestamp, price, price - 1e18, price + 1e18, true, false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signingKey,
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(reportData)))
        );
        signedReport = abi.encode(reportData, r, s, v);
    }

    /// @dev `PriceRequestedV2(uint256 indexed orderId, OrderType, bytes32 feed, uint256 timestamp)`.
    ///      The upkeep rejects any report whose timestamp is not byte-identical to the one it
    ///      recorded for the order, so both values have to come out of the emitted log rather
    ///      than being guessed from `block.timestamp`.
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

    function _fundTrader(uint256 amount) internal {
        USDW(d.collateral).mint(trader, amount);
        // The collateral is pulled by tradingStorage, not by the trading entrypoint.
        vm.prank(trader);
        IERC20(d.collateral).approve(d.tradingStorage, type(uint256).max);
    }

    function _openMarketTrade(uint256 collateral) internal returns (uint256 orderId, uint32 timestamp) {
        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).openTrade(
            IOstiumTradingStorage.Trade({
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
            IOstiumTradingStorage.BuilderFee({builder: address(0), builderFee: 0}),
            IOstiumTradingStorage.OpenOrderType.MARKET,
            100
        );
        return _lastPriceRequest();
    }

    function _deliver(uint256 orderId, bytes memory report, address from) internal {
        vm.prank(from);
        IOstiumPriceUpKeep(d.priceUpKeep).performUpkeep(abi.encode(report, orderId));
    }

    function _openCollateral() internal view returns (uint256 collateral) {
        (collateral,,,,,,,,,) = IOstiumTradingStorage(d.tradingStorage).openTrades(trader, 0, 0);
    }

    function test_openAndClosePosition() public {
        _configureAll();
        _fundTrader(10_000e6);

        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);
        _deliver(orderId, _buildReport(bytes32("BTC/USD"), timestamp, BTC_65K, SIGNER_KEY), keeper);

        assertGt(_openCollateral(), 0, "delivering a valid report must open the position");

        uint256 balanceBeforeClose = IERC20(d.collateral).balanceOf(trader);

        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarket(0, 0, 0, uint192(uint256(int256(BTC_65K))), 100);
        (uint256 closeOrderId, uint32 closeTimestamp) = _lastPriceRequest();
        _deliver(
            closeOrderId,
            _buildReport(bytes32("BTC/USD"), closeTimestamp, BTC_65K, SIGNER_KEY),
            keeper
        );

        assertEq(_openCollateral(), 0, "closing must clear the position");
        assertGt(
            IERC20(d.collateral).balanceOf(trader),
            balanceBeforeClose,
            "the closed position must return collateral to the trader"
        );
    }

    function test_unregisteredSignerReverts() public {
        _configureAll();
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        bytes memory report = _buildReport(bytes32("BTC/USD"), timestamp, BTC_65K, ROGUE_KEY);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IOstiumVerifier.NotAuthorizedSigner.selector, vm.addr(ROGUE_KEY))
        );
        IOstiumPriceUpKeep(d.priceUpKeep).performUpkeep(abi.encode(report, orderId));
    }

    function test_wrongTimestampReverts() public {
        _configureAll();
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        bytes memory report = _buildReport(bytes32("BTC/USD"), timestamp + 1, BTC_65K, SIGNER_KEY);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IOstiumPriceUpKeep.InvalidPrice.selector, orderId));
        IOstiumPriceUpKeep(d.priceUpKeep).performUpkeep(abi.encode(report, orderId));
    }

    function test_nonForwarderReverts() public {
        _configureAll();
        _fundTrader(10_000e6);
        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);

        bytes memory report = _buildReport(bytes32("BTC/USD"), timestamp, BTC_65K, SIGNER_KEY);
        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(IOstiumForwarded.NotForwarder.selector, address(0xBAD))
        );
        IOstiumPriceUpKeep(d.priceUpKeep).performUpkeep(abi.encode(report, orderId));
    }

    /// @dev The one failure mode that does NOT revert. With an empty vault,
    ///      `withinExposureLimits` compares the collateral against
    ///      `maxCollateralP * vault.currentBalance() / 10000`, which is zero, so the callback
    ///      cancels the trade with `CancelReason.EXPOSURE_LIMITS` and refunds the collateral
    ///      minus the oracle fee. A test asserting only "the transaction succeeded" would pass
    ///      while no position exists — hence the explicit zero-collateral assertion.
    function test_emptyVaultCancelsSilently() public {
        _configureMarketOnly(); // no vault seeding: currentBalance() stays zero
        _fundTrader(10_000e6);

        (uint256 orderId, uint32 timestamp) = _openMarketTrade(1000e6);
        _deliver(orderId, _buildReport(bytes32("BTC/USD"), timestamp, BTC_65K, SIGNER_KEY), keeper);

        assertEq(_openCollateral(), 0, "an empty vault must leave no position behind");
    }
}
