// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import './IWhitespacePriceUpKeep.sol';

interface IWhitespacePriceRouter {
    error WrongParams();
    error WrongTimestamp();
    error NotGov(address a);
    error NotTrading(address a);

    event MaxTsValidityUpdated(uint32 value);

    function maxTsValidity() external returns (uint32);

    //only trading
    function getPrice(uint16, IWhitespacePriceUpKeep.OrderType, uint256) external returns (uint256);

    // onluy gov
    function setMaxTsValidity(uint32 value) external;
}
