// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Smoke-test contract proving the pinned toolchain compiles and deploys.
contract Probe {
    function currentBlock() external view returns (uint256) {
        return block.number;
    }
}
