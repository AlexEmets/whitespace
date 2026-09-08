// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Probe} from "../src/Probe.sol";

contract ProbeTest is Test {
    Probe internal probe;

    function setUp() public {
        probe = new Probe();
    }

    function test_returnsBlockNumber() public {
        vm.roll(12345);
        assertEq(probe.currentBlock(), 12345);
    }
}
