// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import './interfaces/IWhitespaceRegistry.sol';
import './interfaces/IWhitespacePriceUpKeep.sol';
import './interfaces/IWhitespacePriceRouter.sol';

import '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';

contract WhitespacePriceRouter is IWhitespacePriceRouter, Initializable {
    IWhitespaceRegistry public registry;

    uint32 constant MAX_TS_VALIDITY = 900; // 15 min

    uint256 public currentOrderId;
    uint32 public maxTsValidity;

    constructor() {
        _disableInitializers();
    }

    function initialize(IWhitespaceRegistry _registry, uint32 _maxTsValidity, uint256 _currentOrderId)
        external
        initializer
    {
        if (address(_registry) == address(0) || _maxTsValidity > MAX_TS_VALIDITY || _maxTsValidity == 0) {
            revert WrongParams();
        }

        registry = _registry;
        _setMaxTsValidity(_maxTsValidity);
        currentOrderId = _currentOrderId;
    }

    modifier onlyGov() {
        _onlyGov();
        _;
    }

    function _onlyGov() private view {
        if (msg.sender != registry.gov()) {
            revert NotGov(msg.sender);
        }
    }

    modifier onlyTrading() {
        _onlyTrading();
        _;
    }

    function _onlyTrading() private view {
        if (msg.sender != registry.getContractAddress('trading')) {
            revert NotTrading(msg.sender);
        }
    }

    function setMaxTsValidity(uint32 value) external onlyGov {
        _setMaxTsValidity(value);
    }

    function _setMaxTsValidity(uint32 value) private {
        if (value > MAX_TS_VALIDITY || value == 0) {
            revert WrongParams();
        }

        maxTsValidity = value;
        emit MaxTsValidityUpdated(value);
    }

    function getPrice(uint16 pairIndex, IWhitespacePriceUpKeep.OrderType orderType, uint256 timestamp)
        external
        onlyTrading
        returns (uint256)
    {
        if (timestamp > block.timestamp || (block.timestamp - timestamp > maxTsValidity)) {
            revert WrongTimestamp();
        }

        ++currentOrderId;
        string memory priceUpkeepType =
            IWhitespacePairsStorage(registry.getContractAddress('pairsStorage')).oracle(pairIndex);
        IWhitespacePriceUpKeep(
                payable(registry.getContractAddress(bytes32(abi.encodePacked(priceUpkeepType, 'PriceUpkeep'))))
            ).getPrice(currentOrderId, pairIndex, orderType, timestamp);

        return currentOrderId;
    }
}
