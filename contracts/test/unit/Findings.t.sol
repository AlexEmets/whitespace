// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {TestnetTrading} from "../helpers/TestnetTrading.sol";

/// @notice Regression tests for defects in `contracts/src` found while writing the
///         testnet-perfect contract suites.
contract FindingsTest is TestnetTrading {
    address internal trader = address(0x7AA);
    address internal shorter = address(0x7AB);

    function setUp() public {
        _setUpTestnet();
        _fundTrader(trader, 1_000_000e6);
        _fundTrader(shorter, 1_000_000e6);
    }

    /// @notice Regression (was low severity): a short open could leave the short side's OI above
    ///         `maxOi`. Fixed by valuing a short's notional at the oracle price over its fill price
    ///         in `withinExposureLimits`.
    ///
    ///         The exposure check (`TradingCallbacksLib.withinExposureLimits`) charges a new
    ///         trade `collateral x leverage` — the PRE-fee notional — against the cap, but the OI
    ///         actually stored is `postFeeNotional / fillPrice` units. A short fills BELOW the
    ///         oracle price by the price impact, so its units are worth
    ///         `postFeeNotional x price / fillPrice` = `postFee / (1 - impact)` at the oracle
    ///         price. Whenever impact exceeds the fee fraction (`takerFee x leverage` plus the
    ///         oracle fee), a short admitted exactly at the cap leaves OI above it. Longs are
    ///         unaffected (they fill above the price, so their units are worth less).
    ///
    ///         Reproduction on WBT (100k cap, K = 1e19): five same-block 100k long round trips
    ///         load ~490k of sell volume, then a 20,000 USDW 5x short (100,000 pre-fee, exactly
    ///         the cap) fills with ~0.55% impact against a 0.03% fee.
    function test_aShortOpenCannotLeaveOiAboveTheCap() public {
        for (uint256 i = 0; i < 5; i++) {
            _openAt(trader, WBT, 4_000e6, 2_500, true, _basePrice(WBT));
            _closeAt(trader, WBT, 0, 0, _basePrice(WBT));
        }
        (, uint256 sellVol,) = pairInfos.pairDynamicSpreadState(WBT);
        assertGt(sellVol, 400_000e18, "sell-side volume loaded by the long closes");
        uint256 cap = ts.openInterest(WBT, 2);
        assertEq(cap, 100_000e6, "WBT cap");
        assertEq(_oi(WBT, false), 0, "no shorts yet");

        // Exactly at the cap by pre-fee notional (20,000 x 5 = 100,000), but its fill is ~0.55%
        // below the oracle, so its units are worth more than the cap: it must be refused.
        uint256 shorterBefore = usdw.balanceOf(shorter);
        vm.recordLogs();
        _fillAt(_tradeFull(shorter, WBT, 20_000e6, 500, false, _upx(WBT), 0, 0), _basePrice(WBT));
        assertEq(_oi(WBT, false), 0, "the over-cap short was cancelled, not opened");
        assertEq(ts.openTradesCount(shorter, WBT), 0, "no position for the refused short");
        _assertCancelledFor(vm.getRecordedLogs(), 6); // CancelReason.EXPOSURE_LIMITS
        assertGt(usdw.balanceOf(shorter), shorterBefore - 20_000e6, "the cancelled short's collateral came back");

        // A short with room under the cap still opens, and stays under it.
        _openAt(shorter, WBT, 10_000e6, 500, false, _basePrice(WBT));
        uint256 shortValue = _oi(WBT, false) * uint256(int256(_basePrice(WBT))) / 1e18 / 1e12;
        assertGt(shortValue, 0, "the smaller short opened");
        assertLe(shortValue, cap, "short OI stays within maxOi");
    }

    /// @dev `MarketOpenCanceled(uint256 indexed orderId, address indexed trader, uint256 indexed pairIndex, CancelReason)`.
    function _assertCancelledFor(Vm.Log[] memory logs, uint8 reason) internal pure {
        bytes32 sig = keccak256("MarketOpenCanceled(uint256,address,uint256,uint8)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) {
                assertEq(abi.decode(logs[i].data, (uint8)), reason, "cancel reason");
                return;
            }
        }
        revert("no MarketOpenCanceled emitted");
    }
}
