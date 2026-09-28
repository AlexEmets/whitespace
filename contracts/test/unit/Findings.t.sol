// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestnetTrading} from "../helpers/TestnetTrading.sol";

/// @notice Defects in `contracts/src` found while writing the testnet-perfect contract suites.
///         Each `test_BUG_*` PASSES while the defect is present — it asserts the faulty
///         outcome — so the suite stays green and the test flips red the day `src` is fixed,
///         at which point it should be inverted into a regression test. `src` is deliberately
///         not touched here.
contract FindingsTest is TestnetTrading {
    address internal trader = address(0x7AA);
    address internal shorter = address(0x7AB);

    function setUp() public {
        _setUpTestnet();
        _fundTrader(trader, 1_000_000e6);
        _fundTrader(shorter, 1_000_000e6);
    }

    /// @notice BUG (low): a short open can leave the short side's OI above `maxOi`.
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
    ///         the cap) fills with ~0.55% impact against a 0.06% fee.
    function test_BUG_shortOpenCanLeaveOiAboveTheCap() public {
        for (uint256 i = 0; i < 5; i++) {
            _openAt(trader, WBT, 4_000e6, 2_500, true, _basePrice(WBT));
            _closeAt(trader, WBT, 0, 0, _basePrice(WBT));
        }
        (, uint256 sellVol,) = pairInfos.pairDynamicSpreadState(WBT);
        assertGt(sellVol, 400_000e18, "sell-side volume loaded by the long closes");
        uint256 cap = ts.openInterest(WBT, 2);
        assertEq(cap, 100_000e6, "WBT cap");
        assertEq(_oi(WBT, false), 0, "no shorts yet");

        // exactly at the cap by the check's own measure: 20,000 x 5 = 100,000
        _openAt(shorter, WBT, 20_000e6, 500, false, _basePrice(WBT));

        uint256 shortValue = _oi(WBT, false) * uint256(int256(_basePrice(WBT))) / 1e18 / 1e12;
        assertGt(shortValue, cap, "BUG: short OI above maxOi right after a successful open");
    }
}
