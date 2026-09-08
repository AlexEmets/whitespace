// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChainUtils} from "../src/vendor/ostium/lib/ChainUtils.sol";

contract ChainUtilsHarness {
    function blockNumber() external view returns (uint256) {
        return ChainUtils.getBlockNumber();
    }
}

contract ChainUtilsTest is Test {
    ChainUtilsHarness internal harness;

    function setUp() public {
        harness = new ChainUtilsHarness();
    }

    function test_returnsBlockNumberOnWhitechainTestnetOp() public {
        vm.chainId(1874);
        vm.roll(777);
        assertEq(harness.blockNumber(), 777);
    }

    function test_returnsBlockNumberOnWhitechainTestnetLegacy() public {
        vm.chainId(2625);
        vm.roll(888);
        assertEq(harness.blockNumber(), 888);
    }

    function test_returnsBlockNumberOnWhitechainMainnet() public {
        vm.chainId(1875);
        vm.roll(999);
        assertEq(harness.blockNumber(), 999);
    }

    /// @dev The Arbitrum branch is unreachable on our chain ids, so `block.number` is the
    ///      only path taken. This fuzz test covers the whole non-Arbitrum chain-id space,
    ///      which is what makes keeping the vendored library unmodified safe.
    function testFuzz_returnsBlockNumberForAnyNonArbitrumChain(uint64 chainId, uint32 height)
        public
    {
        vm.assume(chainId != 42161 && chainId != 421613 && chainId != 421614);
        vm.assume(chainId != 0);
        vm.chainId(chainId);
        vm.roll(height);
        assertEq(harness.blockNumber(), height);
    }
}
