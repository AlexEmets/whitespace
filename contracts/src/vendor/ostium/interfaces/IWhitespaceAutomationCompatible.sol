// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import 'src/interfaces/IWhitespaceTradingStorage.sol';

interface IWhitespaceAutomationCompatible {
    struct SimplifiedTradeId {
        address trader;
        uint256 pairId;
        uint256 index;
        IWhitespaceTradingStorage.LimitOrder limitOrder;
    }

    function performUpkeep(bytes calldata performData) external;
}
