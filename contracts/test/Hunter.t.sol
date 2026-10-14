// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Hunter} from "../src/nft/Hunter.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @dev A contract that cannot receive ERC-721s (no `onERC721Received`).
contract NonReceiver {}

/// @dev Exposes the two internal renderers so the on-chain-metadata content can be asserted
///      directly, without decoding base64 in Solidity.
contract HunterHarness is Hunter {
    constructor(address owner_) Hunter(owner_) {}

    function tokenJSON(uint256 id) external pure returns (string memory) {
        return _tokenJSON(id);
    }

    function tokenSVG(uint256 id) external pure returns (string memory) {
        return _tokenSVG(id);
    }
}

contract HunterTest is Test {
    HunterHarness internal hunter;
    address internal owner = address(this);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        hunter = new HunterHarness(owner);
    }

    /// @dev Lets this test contract stand in for an EOA owner: `_safeMint` checks the recipient
    ///      can receive ERC-721s, and without this hook a mint to `owner` (= address(this))
    ///      reverts `ERC721InvalidReceiver` — which `test_safeMintRejectsNonReceiver` asserts
    ///      for a contract that lacks it.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // --- metadata / configuration ---------------------------------------------------------

    function test_nameAndSymbol() public view {
        assertEq(hunter.name(), "Hunter");
        assertEq(hunter.symbol(), "HUNT");
    }

    function test_capIs100() public view {
        assertEq(hunter.MAX_SUPPLY(), 100);
    }

    function test_startsEmpty() public view {
        assertEq(hunter.totalMinted(), 0);
        assertEq(hunter.remaining(), 100);
        assertEq(hunter.totalSupply(), 0);
    }

    // --- mint ------------------------------------------------------------------------------

    function test_mintAssignsSequentialIdsFromZero() public {
        assertEq(hunter.mint(alice), 0);
        assertEq(hunter.mint(alice), 1);
        assertEq(hunter.mint(bob), 2);

        assertEq(hunter.ownerOf(0), alice);
        assertEq(hunter.ownerOf(1), alice);
        assertEq(hunter.ownerOf(2), bob);
        assertEq(hunter.balanceOf(alice), 2);
        assertEq(hunter.balanceOf(bob), 1);
    }

    function test_mintUpdatesSupplyCounters() public {
        hunter.mint(alice);
        assertEq(hunter.totalMinted(), 1);
        assertEq(hunter.remaining(), 99);
    }

    function test_nonOwnerCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hunter.mint(alice);
    }

    function test_safeMintRejectsNonReceiver() public {
        address bad = address(new NonReceiver());
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, bad));
        hunter.mint(bad);
    }

    // --- mintBatch (seed the owner's wallet) ----------------------------------------------

    function test_mintBatchMintsAllToOneAddress() public {
        hunter.mintBatch(owner, 5);
        assertEq(hunter.totalMinted(), 5);
        assertEq(hunter.balanceOf(owner), 5);
        for (uint256 i; i < 5; ++i) {
            assertEq(hunter.ownerOf(i), owner);
        }
    }

    function test_mintBatchZeroReverts() public {
        vm.expectRevert(Hunter.EmptyBatch.selector);
        hunter.mintBatch(owner, 0);
    }

    function test_nonOwnerCannotMintBatch() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hunter.mintBatch(alice, 1);
    }

    // --- airdrop (reward several hunters) --------------------------------------------------

    function test_airdropMintsOneEach() public {
        address[] memory to = new address[](2);
        to[0] = alice;
        to[1] = bob;
        hunter.airdrop(to);
        assertEq(hunter.ownerOf(0), alice);
        assertEq(hunter.ownerOf(1), bob);
        assertEq(hunter.totalMinted(), 2);
    }

    function test_airdropEmptyReverts() public {
        address[] memory to = new address[](0);
        vm.expectRevert(Hunter.EmptyBatch.selector);
        hunter.airdrop(to);
    }

    function test_nonOwnerCannotAirdrop() public {
        address[] memory to = new address[](1);
        to[0] = alice;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hunter.airdrop(to);
    }

    // --- supply cap (the 256 boundary) -----------------------------------------------------

    function test_canMintExactlyMaxSupply() public {
        hunter.mintBatch(owner, 100);
        assertEq(hunter.totalMinted(), 100);
        assertEq(hunter.remaining(), 0);
        assertEq(hunter.totalSupply(), 100);
        assertEq(hunter.ownerOf(99), owner);
    }

    function test_mintPastCapReverts() public {
        hunter.mintBatch(owner, 100);
        vm.expectRevert(Hunter.MaxSupplyReached.selector);
        hunter.mint(alice);
    }

    function test_mintBatchOverflowingCapReverts() public {
        hunter.mintBatch(owner, 95);
        vm.expectRevert(Hunter.MaxSupplyReached.selector);
        hunter.mintBatch(owner, 7);
        // The reverted batch left the counter untouched.
        assertEq(hunter.totalMinted(), 95);
    }

    function test_airdropOverflowingCapReverts() public {
        hunter.mintBatch(owner, 99);
        address[] memory to = new address[](2);
        to[0] = alice;
        to[1] = bob;
        vm.expectRevert(Hunter.MaxSupplyReached.selector);
        hunter.airdrop(to);
    }

    // --- enumeration (what the frontend reads to list a wallet's badges) ------------------

    function test_tokenOfOwnerByIndexListsOwnersTokens() public {
        hunter.mint(alice); // id 0
        hunter.mint(bob); //   id 1
        hunter.mint(alice); // id 2
        assertEq(hunter.balanceOf(alice), 2);
        assertEq(hunter.tokenOfOwnerByIndex(alice, 0), 0);
        assertEq(hunter.tokenOfOwnerByIndex(alice, 1), 2);
        assertEq(hunter.tokenOfOwnerByIndex(bob, 0), 1);
    }

    function test_totalSupplyAndTokenByIndex() public {
        hunter.mint(alice);
        hunter.mint(bob);
        assertEq(hunter.totalSupply(), 2);
        assertEq(hunter.tokenByIndex(0), 0);
        assertEq(hunter.tokenByIndex(1), 1);
    }

    function test_supportsExpectedInterfaces() public view {
        assertTrue(hunter.supportsInterface(0x80ac58cd), "ERC721");
        assertTrue(hunter.supportsInterface(0x5b5e139f), "ERC721Metadata");
        assertTrue(hunter.supportsInterface(0x780e9d63), "ERC721Enumerable");
        assertFalse(hunter.supportsInterface(0xffffffff));
    }

    // --- on-chain metadata -----------------------------------------------------------------

    function test_tokenURIIsBase64JSONDataURI() public {
        hunter.mint(alice);
        string memory uri = hunter.tokenURI(0);
        assertTrue(_startsWith(uri, "data:application/json;base64,"), "json data URI prefix");
        assertGt(bytes(uri).length, bytes("data:application/json;base64,").length);
    }

    function test_tokenURIRevertsForUnminted() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, uint256(0)));
        hunter.tokenURI(0);
    }

    function test_jsonCarriesNameAndEmbeddedImage() public view {
        string memory json = hunter.tokenJSON(7);
        assertTrue(_contains(json, '"name":"Hunter #7"'), "name with serial");
        assertTrue(_contains(json, "data:image/svg+xml;base64,"), "embedded svg image");
        assertTrue(_contains(json, '"value":7'), "serial attribute");
    }

    function test_svgCarriesTitleAndSerial() public view {
        string memory svg = hunter.tokenSVG(42);
        assertTrue(_startsWith(svg, "<svg"), "svg root");
        assertTrue(_contains(svg, ">HUNTER<"), "title");
        assertTrue(_contains(svg, "#42"), "serial drawn");
    }

    // --- string helpers --------------------------------------------------------------------

    function _startsWith(string memory haystack, string memory prefix) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory p = bytes(prefix);
        if (h.length < p.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (h[i] != p[i]) return false;
        }
        return true;
    }

    /// @dev Naive substring search — enough for asserting fixed markers in the rendered output.
    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0) return true;
        if (h.length < n.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool matched = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }
}
