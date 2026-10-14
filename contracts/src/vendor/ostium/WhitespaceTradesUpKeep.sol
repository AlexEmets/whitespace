// SPDX-License-Identifier: MIT
import '@openzeppelin/contracts/utils/math/SafeCast.sol';
import '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';

import 'src/interfaces/IWhitespaceTrading.sol';
import 'src/interfaces/IWhitespaceRegistry.sol';
import 'src/interfaces/IWhitespacePairInfos.sol';
import 'src/interfaces/IWhitespaceForwarded.sol';
import 'src/interfaces/IWhitespaceTradingCallbacks.sol';
import 'src/interfaces/IWhitespacePairsStorage.sol';
import 'src/interfaces/IWhitespaceTradesUpKeep.sol';
import 'src/interfaces/IWhitespaceTradingStorage.sol';
import 'src/interfaces/IWhitespaceAutomationCompatible.sol';
import 'src/interfaces/IOwnable.sol';

pragma solidity ^0.8.24;

contract WhitespaceTradesUpKeep is IWhitespaceTradesUpKeep, IWhitespaceAutomationCompatible, IWhitespaceForwarded, Initializable {
    using SafeCast for uint256;

    IWhitespaceRegistry public registry;

    mapping(address => bool) public isForwarder;

    modifier onlyGov() {
        _onlyGov(msg.sender);
        _;
    }

    function _onlyGov(address a) private view {
        if (a != registry.gov()) revert NotGov(a);
    }

    modifier onlyTimelock() {
        _onlyTimelock();
        _;
    }

    function _onlyTimelock() private view {
        if (msg.sender != IOwnable(address(registry)).owner()) {
            revert NotTimelock(msg.sender);
        }
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(IWhitespaceRegistry _registry) external initializer {
        if (address(_registry) == address(0)) revert WrongParams();
        registry = _registry;
    }

    function performUpkeep(bytes calldata performData) external {
        if (!isForwarder[msg.sender]) {
            revert NotForwarder(msg.sender);
        }
        (SimplifiedTradeId[] memory trades, uint256 timestamp) = abi.decode(performData, (SimplifiedTradeId[], uint256));
        IWhitespaceTrading trading = IWhitespaceTrading(registry.getContractAddress('trading'));
        for (uint256 i = 0; i < trades.length; i++) {
            if (trades[i].trader != address(0)) {
                IWhitespaceTrading.AutomationOrderStatus status = trading.executeAutomationOrder(
                    trades[i].limitOrder,
                    trades[i].trader,
                    trades[i].pairId.toUint16(),
                    trades[i].index.toUint8(),
                    timestamp
                );
                emit AutomationPerformed(trades[i].limitOrder, trades[i].pairId, status, trades[i].trader);
            }
        }
    }

    function registerForwarder(address forwarderAddress) public onlyTimelock {
        if (isForwarder[forwarderAddress]) revert AlreadyForwarder(forwarderAddress);
        isForwarder[forwarderAddress] = true;
        emit ForwarderAdded(forwarderAddress);
    }

    function registerForwarders(address[] calldata forwarderAddresses) external onlyTimelock {
        for (uint256 i = 0; i < forwarderAddresses.length; i++) {
            registerForwarder(forwarderAddresses[i]);
        }
    }

    function unregisterForwarder(address forwarderAddress) public onlyGov {
        if (!isForwarder[forwarderAddress]) revert NotForwarder(forwarderAddress);
        delete isForwarder[forwarderAddress];
        emit ForwarderRemoved(forwarderAddress);
    }

    function unregisterForwarders(address[] calldata forwarderAddresses) external onlyGov {
        for (uint256 i = 0; i < forwarderAddresses.length; i++) {
            unregisterForwarder(forwarderAddresses[i]);
        }
    }
}

