// SPDX-License-Identifier: MIT
import 'src/interfaces/IWhitespaceTrading.sol';

pragma solidity ^0.8.24;

interface IWhitespaceTradesUpKeep {
    event AutomationPerformed(
        IWhitespaceTradingStorage.LimitOrder indexed limitOrder,
        uint256 indexed pairIndex,
        IWhitespaceTrading.AutomationOrderStatus indexed status,
        address trader
    );

    error WrongParams();
    error NotGov(address a);
    error NotTimelock(address a);
}
