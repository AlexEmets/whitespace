// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {USDW} from "../src/mocks/USDW.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract USDWTest is Test {
    USDW internal usd;
    address internal alice = address(0xA11CE);
    address internal owner = address(this);

    function setUp() public {
        usd = new USDW(owner);
    }

    function test_hasSixDecimals() public view {
        assertEq(usd.decimals(), 6);
    }

    function test_claimMintsFaucetAmount() public {
        vm.prank(alice);
        usd.claim();
        assertEq(usd.balanceOf(alice), usd.FAUCET_AMOUNT());
    }

    function test_secondClaimWithinCooldownReverts() public {
        vm.startPrank(alice);
        usd.claim();
        vm.expectRevert(abi.encodeWithSelector(USDW.CooldownActive.selector, block.timestamp + 1 days));
        usd.claim();
        vm.stopPrank();
    }

    function test_claimSucceedsAfterCooldown() public {
        vm.startPrank(alice);
        usd.claim();
        vm.warp(block.timestamp + 1 days);
        usd.claim();
        vm.stopPrank();
        assertEq(usd.balanceOf(alice), 2 * usd.FAUCET_AMOUNT());
    }

    function test_ownerCanMint() public {
        usd.mint(alice, 500e6);
        assertEq(usd.balanceOf(alice), 500e6);
    }

    function test_nonOwnerCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        usd.mint(alice, 1);
    }
}
