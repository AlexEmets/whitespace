// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestnetTrading} from "../helpers/TestnetTrading.sol";
import {USDW} from "../../src/mocks/USDW.sol";
import {IOstiumVault} from "../../src/vendor/ostium/interfaces/IOstiumVault.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";

/// @notice `OstiumVault` on the testnet deployment: the async request/settle/claim flow, cancel
///         and reclaim, the withdraw delay, oversubscription, how trader PnL moves the share
///         price, the market-maker buffer, and the daily PnL circuit breaker.
contract VaultTest is TestnetTrading {
    address internal lp2 = address(0x1B2);
    address internal lp3 = address(0x1B3);
    address internal trader = address(0x7AA);

    uint256 internal constant SUPPLY = 100_000e6; // the seeded LP's shares at price 1.0

    function setUp() public {
        _setUpTestnet();
        _fundLp(lp2, 50_000e6);
        _fundLp(lp3, 50_000e6);
        _fundLp(marketMaker, 50_000e6);
        _fundTrader(trader, 1_000_000e6);
    }

    function _fundLp(address who, uint256 amount) internal {
        vm.prank(owner);
        USDW(d.collateral).mint(who, amount);
        vm.prank(who);
        usdw.approve(d.vault, type(uint256).max);
    }

    function _next() internal view returns (uint32) {
        return vault.targetSettlementId(true);
    }

    function _settle() internal {
        vm.prank(gov);
        vault.forceSettlement();
    }

    function _deposit(address who, uint256 assets) internal returns (uint32 id) {
        id = _next();
        vm.prank(who);
        vault.requestDeposit(assets);
    }

    // =====================================================================================
    // Deposit: request, settle, claim
    // =====================================================================================

    function test_seededState() public view {
        assertEq(vault.totalSupply(), SUPPLY, "100k shares");
        assertEq(vault.balanceOf(lp), SUPPLY, "held by the seeding LP");
        assertEq(vault.shareToAssetsPrice(), 1e18, "price 1.0");
        assertEq(vault.currentBalance(), LP_AMOUNT, "available assets");
        assertEq(_bal(d.vault), LP_AMOUNT, "USDW in the vault");
        assertEq(vault.getBufferSize(), 0, "no buffer");
    }

    function test_requestDeposit_escrowsAssetsUntilSettlement() public {
        vm.expectRevert(IOstiumVault.NullAmount.selector);
        vm.prank(lp2);
        vault.requestDeposit(0);

        uint32 id = _next();
        vm.expectEmit(true, true, true, true, d.vault);
        emit IOstiumVault.DepositRequestedV2(lp2, id, 5_000e6);
        vm.prank(lp2);
        vault.requestDeposit(5_000e6);

        assertEq(_bal(lp2), 45_000e6, "pulled");
        assertEq(_bal(d.vault), LP_AMOUNT + 5_000e6, "escrowed in the vault");
        assertEq(vault.pendingDepositRequest(lp2, id), 5_000e6, "recorded");
        assertEq(vault.totalAssetsToDeposit(id), 5_000e6, "totalled");
        assertEq(uint8(vault.getDepositStatus(lp2, id)), uint8(IOstiumVault.RequestStatus.PENDING), "pending");
        assertEq(vault.currentBalance(), LP_AMOUNT, "escrow is not LP capital yet");
        assertEq(vault.totalSupply(), SUPPLY, "no shares yet");

        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.DepositNotClaimable.selector, lp2, id));
        vm.prank(lp2);
        vault.claimDeposit(id);
    }

    function test_forcedSettlement_mintsIntoEscrowAndClaimTransfersShares() public {
        uint32 id = _deposit(lp2, 5_000e6);

        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.NotGov.selector, lp2));
        vm.prank(lp2);
        vault.forceSettlement();

        _settle();
        assertEq(vault.lastSettlementId(), id, "settled");
        assertEq(vault.lastSettlementTs(), vm.getBlockTimestamp(), "timestamped");
        assertEq(uint8(vault.getDepositStatus(lp2, id)), uint8(IOstiumVault.RequestStatus.CLAIMABLE), "claimable");
        assertEq(vault.settlementAllocationScaleP(id), 1e18, "fully allocated");
        assertEq(vault.settlementShareToAssetsPrice(id), 1e18, "price locked");
        assertEq(vault.totalSupply(), SUPPLY + 5_000e6, "minted");
        assertEq(vault.balanceOf(d.vault), 5_000e6, "into the vault's own escrow");
        assertEq(vault.currentBalance(), LP_AMOUNT + 5_000e6, "now LP capital");

        vm.expectEmit(true, true, true, true, d.vault);
        emit IOstiumVault.DepositClaimedV2(lp2, id, 5_000e6);
        vm.prank(lp2);
        vault.claimDeposit(id);
        assertEq(vault.balanceOf(lp2), 5_000e6, "shares delivered");
        assertEq(vault.balanceOf(d.vault), 0, "escrow emptied");
        assertEq(uint8(vault.getDepositStatus(lp2, id)), uint8(IOstiumVault.RequestStatus.NONE), "consumed");

        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.DepositNotClaimable.selector, lp2, id));
        vm.prank(lp2);
        vault.claimDeposit(id);
    }

    function test_intervalSettlement_anyoneAfterOneHourAndNotBefore() public {
        uint32 id = _deposit(lp2, 5_000e6);
        uint32 last = vault.lastSettlementTs();
        vm.warp(uint256(last) + 1 hours - 1);
        vm.prank(lp3);
        vault.tryNewSettlement();
        assertEq(vault.lastSettlementId(), id - 1, "too early: no-op");

        vm.warp(uint256(last) + 1 hours);
        vm.prank(lp3);
        vault.tryNewSettlement();
        assertEq(vault.lastSettlementId(), id, "anyone settles once the interval elapsed");
        assertEq(uint8(vault.getDepositStatus(lp2, id)), uint8(IOstiumVault.RequestStatus.CLAIMABLE), "claimable");
    }

    /// @notice A trade close is enough to run an overdue settlement: `receiveAssets` calls
    ///         `tryNewSettlement`.
    function test_intervalSettlement_ranByATradeCloseOnceOverdue() public {
        uint32 id = _deposit(lp2, 5_000e6);
        _open(trader, BTC, 1_000e6, 1_000, true);
        _advance(1 hours);
        _closeAt(trader, BTC, 0, 0, _basePrice(BTC));
        assertEq(vault.lastSettlementId(), id, "settled by the close");
    }

    // =====================================================================================
    // Withdraw, cancel, reclaim, delay
    // =====================================================================================

    function test_withdraw_requestSettleClaimAtThePrice() public {
        uint32 id = vault.targetSettlementId(false);
        vm.expectEmit(true, true, true, true, d.vault);
        emit IOstiumVault.WithdrawRequestedV2(lp, id, 10_000e6);
        vm.prank(lp);
        vault.requestWithdraw(10_000e6);
        assertEq(vault.balanceOf(lp), SUPPLY - 10_000e6, "shares escrowed");
        assertEq(vault.balanceOf(d.vault), 10_000e6, "in the vault");

        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.WithdrawNotClaimable.selector, lp, id));
        vm.prank(lp);
        vault.claimWithdraw(id);

        _settle();
        assertEq(vault.totalSupply(), SUPPLY - 10_000e6, "burned at settlement");
        assertEq(_bal(d.vault), LP_AMOUNT, "assets stay until claimed");

        uint256 before = _bal(lp);
        vm.prank(lp);
        vault.claimWithdraw(id);
        assertEq(_bal(lp) - before, 10_000e6, "paid at price 1.0");
        assertEq(_bal(d.vault), LP_AMOUNT - 10_000e6, "left the vault");
        assertEq(vault.currentBalance(), LP_AMOUNT - 10_000e6, "LP capital reduced");
    }

    function test_cancel_depositAndWithdrawWhilePendingOnly() public {
        uint32 id = _deposit(lp2, 5_000e6);
        vm.expectRevert();
        vm.prank(lp2);
        vault.cancelRequestDeposit(id, 5_000e6 + 1); // more than requested
        vm.prank(lp2);
        vault.cancelRequestDeposit(id, 2_000e6);
        assertEq(_bal(lp2), 47_000e6, "partial cancel refunded");
        assertEq(vault.totalAssetsToDeposit(id), 3_000e6, "total reduced");

        uint32 wid = vault.targetSettlementId(false);
        vm.prank(lp);
        vault.requestWithdraw(1_000e6);
        vm.prank(lp);
        vault.cancelRequestWithdraw(wid, 400e6);
        assertEq(vault.balanceOf(lp), SUPPLY - 600e6, "shares returned");
        assertEq(vault.totalSharesToWithdraw(wid), 600e6, "total reduced");

        _settle();
        vm.expectRevert(); // no longer PENDING
        vm.prank(lp2);
        vault.cancelRequestDeposit(id, 1);
        vm.expectRevert();
        vm.prank(lp);
        vault.cancelRequestWithdraw(wid, 1);
        vm.expectRevert(IOstiumVault.NullAmount.selector);
        vm.prank(lp2);
        vault.cancelRequestDeposit(id, 0);
    }

    /// @notice A supply cap already reached turns the whole settlement's deposits RECLAIMABLE.
    function test_reclaimDeposit_whenTheVaultCannotAcceptAny() public {
        vm.prank(gov);
        vault.updateSupplyCap(SUPPLY);
        uint32 id = _deposit(lp2, 5_000e6);
        vm.expectEmit(true, true, true, true, d.vault);
        emit IOstiumVault.TotalAssetsToDepositAboveMax(id, 5_000e6, 0);
        _settle();
        assertEq(uint8(vault.getDepositStatus(lp2, id)), uint8(IOstiumVault.RequestStatus.RECLAIMABLE), "reclaimable");
        assertEq(vault.totalSupply(), SUPPLY, "nothing minted");

        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.DepositNotClaimable.selector, lp2, id));
        vm.prank(lp2);
        vault.claimDeposit(id);
        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.DepositNotReclaimable.selector, lp3, id));
        vm.prank(lp3);
        vault.reclaimDeposit(id);

        vm.prank(lp2);
        vault.reclaimDeposit(id);
        assertEq(_bal(lp2), 50_000e6, "all back");
        assertEq(_bal(d.vault), LP_AMOUNT, "escrow released");
    }

    /// @notice Redeeming the whole supply exceeds `totalSupply() - 1`: the request is voided
    ///         and the shares come back.
    function test_reclaimWithdraw_whenTheRequestExceedsTheRedeemableMaximum() public {
        uint32 id = vault.targetSettlementId(false);
        vm.prank(lp);
        vault.requestWithdraw(SUPPLY);
        _settle();
        assertEq(uint8(vault.getWithdrawStatus(lp, id)), uint8(IOstiumVault.RequestStatus.RECLAIMABLE), "reclaimable");
        assertEq(vault.totalSupply(), SUPPLY, "nothing burned");
        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.WithdrawNotReclaimable.selector, lp2, id));
        vm.prank(lp2);
        vault.reclaimWithdraw(id);
        vm.prank(lp);
        vault.reclaimWithdraw(id);
        assertEq(vault.balanceOf(lp), SUPPLY, "shares back");
    }

    function test_withdrawSettlementDelay_pushesTheTargetSettlement() public {
        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.WrongParams.selector));
        vm.prank(gov);
        vault.updateWithdrawSettlementDelay(11);
        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.NotGov.selector, lp));
        vm.prank(lp);
        vault.updateWithdrawSettlementDelay(2);

        vm.prank(gov);
        vault.updateWithdrawSettlementDelay(2);
        uint32 id = vault.targetSettlementId(false);
        assertEq(id, vault.lastSettlementId() + 3, "two extra settlements");
        vm.prank(lp);
        vault.requestWithdraw(1_000e6);

        _settle();
        _settle();
        assertEq(uint8(vault.getWithdrawStatus(lp, id)), uint8(IOstiumVault.RequestStatus.PENDING), "still pending after two");
        _settle();
        assertEq(uint8(vault.getWithdrawStatus(lp, id)), uint8(IOstiumVault.RequestStatus.CLAIMABLE), "claimable after three");
        vm.prank(lp);
        vault.claimWithdraw(id);
        assertEq(_bal(lp), 1_000e6, "paid");
    }

    /// @notice Two depositors asking for 6,000 against 3,000 of cap room each get half, pro
    ///         rata, and the rest back in USDW.
    function test_oversubscription_scalesEveryDepositorProRata() public {
        vm.prank(gov);
        vault.updateSupplyCap(SUPPLY + 3_000e6);
        uint32 id = _deposit(lp2, 4_000e6);
        _deposit(lp3, 2_000e6);

        vm.expectEmit(true, true, true, true, d.vault);
        emit IOstiumVault.TotalAssetsToDepositCapped(id, 6_000e6, 3_000e6);
        _settle();
        assertEq(vault.settlementAllocationScaleP(id), 0.5e18, "half allocated");
        assertEq(vault.totalAssetsToDeposit(id), 3_000e6, "capped");
        assertEq(vault.totalSupply(), SUPPLY + 3_000e6, "exactly the cap");

        vm.expectEmit(true, true, true, true, d.vault);
        emit IOstiumVault.DepositPartiallyRefunded(lp2, id, 2_000e6);
        vm.prank(lp2);
        vault.claimDeposit(id);
        vm.prank(lp3);
        vault.claimDeposit(id);
        assertEq(vault.balanceOf(lp2), 2_000e6, "lp2 shares");
        assertEq(vault.balanceOf(lp3), 1_000e6, "lp3 shares");
        assertEq(_bal(lp2), 48_000e6, "lp2 refund");
        assertEq(_bal(lp3), 49_000e6, "lp3 refund");
        assertEq(vault.balanceOf(d.vault), 0, "escrow exact");
        assertEq(_bal(d.vault), LP_AMOUNT + 3_000e6, "only the allocated part stayed");
    }

    // =====================================================================================
    // Share price and trader PnL
    // =====================================================================================

    /// @dev Opens and closes a 1,000 USDW 10x BTC long, entering at base and exiting at
    ///      base moved by `bps`. Returns the vault's net USDW change from the close.
    function _roundTrip(int256 bps) internal returns (int256 vaultDelta) {
        _open(trader, BTC, 1_000e6, 1_000, true);
        uint256 before = _bal(d.vault);
        _closeAt(trader, BTC, 0, 0, _px(BTC, bps));
        vaultDelta = int256(_bal(d.vault)) - int256(before);
    }

    function test_openingFeeRaisesTheSharePriceImmediately() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        assertEq(vault.accRewardsPerToken(), uint256(3e6) * 1e18 / SUPPLY, "vault half of the fee per share");
        assertEq(vault.shareToAssetsPrice(), 1e18 + uint256(3e6) * 1e18 / SUPPLY, "price up without a settlement");
    }

    function test_traderWin_lowersTheSharePriceAtSettlement() public {
        int256 delta = _roundTrip(200);
        assertLt(delta, 0, "the vault paid a winner");
        uint256 paid = uint256(-delta);
        uint256 priceBefore = vault.shareToAssetsPrice();
        assertEq(priceBefore, vault.maxAccPnlPerToken(), "PnL does not move the price until settlement");

        _settle();
        uint256 expected = vault.maxAccPnlPerToken() - (paid * 1e18 + SUPPLY - 1) / SUPPLY;
        assertApproxEqAbs(vault.shareToAssetsPrice(), expected, 2, "price falls by the payout per share");
        assertLt(vault.shareToAssetsPrice(), priceBefore, "LPs lost");

        // an LP leaving now realises the loss
        uint32 id = vault.targetSettlementId(false);
        vm.prank(lp);
        vault.requestWithdraw(10_000e6);
        _settle();
        uint256 before = _bal(lp);
        vm.prank(lp);
        vault.claimWithdraw(id);
        assertEq(_bal(lp) - before, uint256(10_000e6) * vault.settlementShareToAssetsPrice(id) / 1e18, "at the settled price");
        assertLt(_bal(lp) - before, 10_000e6 + 10_000e6 * uint256(3e6) / SUPPLY, "less than deposited plus fees");
    }

    function test_traderLossAfterAWin_restoresTheSharePrice() public {
        _roundTrip(200);
        _settle();
        uint256 afterWin = vault.shareToAssetsPrice();
        _roundTrip(-200);
        _settle();
        assertGt(vault.shareToAssetsPrice(), afterWin, "LPs recovered");
        assertEq(vault.shareToAssetsPrice(), vault.maxAccPnlPerToken(), "a bigger loss than win caps at max");
        assertGt(vault.getBufferSize(), 0, "the excess becomes buffer");
    }

    /// @notice From a neutral vault, a trader's loss does NOT raise the share price: it caps at
    ///         1.0 + rewards and the loss accumulates as buffer (for the market maker).
    function test_traderLossFromNeutral_becomesBufferNotSharePrice() public {
        int256 delta = _roundTrip(-200);
        assertGt(delta, 0, "the vault kept a loser's collateral");
        _settle();
        assertEq(vault.shareToAssetsPrice(), vault.maxAccPnlPerToken(), "price capped at 1.0 + rewards");
        assertApproxEqAbs(uint256(vault.getBufferSize()), uint256(delta), 1, "loss recorded as buffer");
    }

    /// @notice Unrealised PnL counts at settlement: an open winner lowers the price before it
    ///         is closed.
    function test_openPnlOfAnOpenWinnerIsChargedAtSettlement() public {
        _open(trader, BTC, 1_000e6, 1_000, true);
        // a second trade at +2% is what moves the protocol's last trade price
        address marker = address(0x3A3);
        _fundTrader(marker, 1_000e6);
        _openAt(marker, BTC, 20e6, 100, false, _px(BTC, 200));
        uint256 before = vault.shareToAssetsPrice();
        _settle();
        assertGt(openPnl.getOpenPnl(), 0, "traders are net up");
        assertLt(vault.shareToAssetsPrice(), before, "open PnL priced in");
        assertGt(vault.lastSettlementOpenPnl(), 0, "recorded");
    }

    // =====================================================================================
    // Market maker
    // =====================================================================================

    function test_mm_depositBuildsBufferAndWithdrawIsBoundedByIt() public {
        vm.expectRevert(abi.encodeWithSelector(IOstiumVault.NotMM.selector, lp));
        vm.prank(lp);
        vault.mmDeposit(1e6);
        vm.expectRevert(IOstiumVault.ZeroAmount.selector);
        vm.prank(marketMaker);
        vault.mmDeposit(0);

        uint32 idBefore = vault.lastSettlementId();
        vm.prank(marketMaker);
        vault.mmDeposit(5_000e6);
        assertEq(vault.getBufferSize(), 5_000e6, "buffer");
        assertEq(_bal(d.vault), LP_AMOUNT + 5_000e6, "USDW in");
        assertEq(vault.shareToAssetsPrice(), 1e18, "LP price unchanged");
        assertEq(vault.lastSettlementId(), idBefore + 1, "an MM settlement");

        vm.startPrank(marketMaker);
        vm.expectRevert(IOstiumVault.InsufficientBuffer.selector);
        vault.mmWithdraw(5_000e6 + 1, marketMaker);
        vm.expectRevert(IOstiumVault.NullAddr.selector);
        vault.mmWithdraw(1e6, address(0));
        vm.expectRevert(IOstiumVault.ZeroAmount.selector);
        vault.mmWithdraw(0, marketMaker);
        vault.mmWithdraw(5_000e6, marketMaker);
        vm.stopPrank();
        assertEq(vault.getBufferSize(), 0, "buffer spent");
        assertEq(_bal(marketMaker), 50_000e6, "all back");
        assertEq(_bal(d.vault), LP_AMOUNT, "vault back to seed");
    }

    function test_mm_depositAlsoSettlesPendingLpRequests() public {
        uint32 id = _deposit(lp2, 1_000e6);
        vm.prank(marketMaker);
        vault.mmDeposit(1_000e6);
        assertEq(uint8(vault.getDepositStatus(lp2, id)), uint8(IOstiumVault.RequestStatus.CLAIMABLE), "settled by the MM");
    }

    // =====================================================================================
    // Daily PnL circuit breaker
    // =====================================================================================

    /// @notice Characterisation: a winning close that would pay out more than 10% of the vault
    ///         in one day (`maxDailyAccPnlDeltaPerToken` = 0.1) reverts the keeper's delivery.
    ///         The position stays open; the trader's only way out is the close timeout.
    function test_dailyPnlCap_revertsAnOversizedWinningClose() public {
        _openAt(trader, BTC, 10_000e6, 10_000, true, _basePrice(BTC));
        (uint256 id, uint32 t) = _requestClose(trader, BTC, 0, 0, uint192(uint256(int256(_px(BTC, 200)))), 500);
        bytes memory report = this.signedReportExt(BTC, t, _px(BTC, 200), true);
        vm.expectRevert(IOstiumVault.MaxDailyPnlReached.selector);
        _deliver(id, report);
        assertEq(ts.openTradesCount(trader, BTC), 1, "position still open");

        _advance(MARKET_TIMEOUT);
        vm.prank(trader);
        trading.closeTradeMarketTimeout(id, false);
        assertEq(ts.pendingOrderIdsCount(trader), 0, "trader released the close");
    }
}
