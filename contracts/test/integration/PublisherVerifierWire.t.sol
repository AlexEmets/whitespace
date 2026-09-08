// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {OstiumRegistry} from "../../src/vendor/ostium/OstiumRegistry.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {WhitespaceVerifier} from "../../src/oracle/WhitespaceVerifier.sol";

/// @notice The wire format across the language boundary: bytes produced by the JavaScript
///         publisher, fed verbatim to the Solidity verifier.
///
/// @dev    Why this exists. `packages/reporter/src/report-v2.mjs` and
///         `src/oracle/WhitespaceVerifier.sol` were written independently from a written
///         spec. Each is thoroughly tested — against its OWN reading of that spec. A shared
///         misreading (field order, the EIP-191 prefix, `bytes[]` vs packed signatures, the
///         sort key) passes both suites and fails only on a live chain, where the symptom is
///         every price delivery reverting and the exchange being down.
///
///         The constants below are not hand-written. Regenerate them with:
///             node packages/reporter/scripts/gen-v2-fixture.mjs
///         If either side's encoding changes without the other's, this test fails loudly,
///         which is the entire point.
contract PublisherVerifierWireTest is Test {
    // Same keys the JS fixture generator signs with.
    uint256 internal constant K1 = 0xA11CE01;
    uint256 internal constant K2 = 0xA11CE02;
    uint256 internal constant K3 = 0xA11CE03;

    /// @dev Pinned because the verifier address is INSIDE the signed payload (domain
    ///      separation), so the publisher has to know it before signing. `deployCodeTo` puts
    ///      the real contract at the address the fixture was signed for.
    address internal constant VERIFIER_ADDR = 0x000000000000000000000000000000000000bEEF;
    uint256 internal constant CHAIN_ID = 1874;

    // Produced by node packages/reporter/scripts/gen-v2-fixture.mjs
    bytes internal constant REPORT_DATA =
        hex"0000000000000000000000000000000000000000000000000000000000000752000000000000000000000000000000000000000000000000000000000000beef4254432f55534400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006553f100000000000000000000000000000000000000000000000dc3a8351f3d86a00000000000000000000000000000000000000000000000000dc39a546889df3c0000000000000000000000000000000000000000000000000dc3b615d5f12e04000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000";

    bytes internal constant SIGNED_REPORT =
        hex"0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000752000000000000000000000000000000000000000000000000000000000000beef4254432f55534400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006553f100000000000000000000000000000000000000000000000dc3a8351f3d86a00000000000000000000000000000000000000000000000000dc39a546889df3c0000000000000000000000000000000000000000000000000dc3b615d5f12e040000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000041891accae9232bff08a195859eb91230f15bf52c621c62271fdbe8e45c62d578737d18fed2c06a7a0a5beb0faa6af61613031795eedc58b2235ca2bdeba7a76ef1b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000419df8b5ca18c2f37168cdaa8d0f1ebc0290c9f5282c224ce90f2f7b803c20918a614ee8d6e1a2dcdc5015f19e802a48f445d6d3e96ef5a79886b47c4d9b81747a1c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041b0e84c08af253b4e83978cdf7730f4b88f4a7cb6600ee261079044bcc477c6404b5e062a38f5b459147952e646712ac18fc6d50c2088944036950e452e21b3d21b00000000000000000000000000000000000000000000000000000000000000";

    WhitespaceVerifier internal verifier;

    address internal gov = address(0x60F);

    function setUp() public {
        vm.chainId(CHAIN_ID);

        OstiumRegistry registry = new OstiumRegistry(gov, address(0xDE7), address(0xA11), address(0x0E1));

        address[] memory signers = new address[](3);
        signers[0] = vm.addr(K1);
        signers[1] = vm.addr(K2);
        signers[2] = vm.addr(K3);

        deployCodeTo(
            "WhitespaceVerifier.sol:WhitespaceVerifier",
            abi.encode(IOstiumRegistry(address(registry)), signers, uint256(3)),
            VERIFIER_ADDR
        );
        verifier = WhitespaceVerifier(VERIFIER_ADDR);
    }

    /// @dev Both languages must derive the same address set from the same private keys. Asserted
    ///      as a SET, not positionally: the fixture is ordered by address, which is not the order
    ///      the keys are declared in, and pinning the positional mapping would only encode that
    ///      coincidence. If this fails, nothing below it means anything.
    function test_keyDerivationAgreesAcrossLanguages() public pure {
        address[3] memory fromKeys = [vm.addr(K1), vm.addr(K2), vm.addr(K3)];
        address[3] memory fromFixture = [
            0x12D1D4587c2D1Eb765bf4DC2f92122443b88c75b,
            0x1bE4D27583DD1951B27454cE7871121a4bb2854C,
            0x616d2cBB7165c07ab883D76Da1861971dE111127
        ];

        for (uint256 i = 0; i < 3; i++) {
            bool found;
            for (uint256 j = 0; j < 3; j++) {
                if (fromFixture[i] == fromKeys[j]) found = true;
            }
            assertTrue(found, "fixture signer not derivable from the shared test keys");
        }
        // Distinctness, so the loop above cannot be satisfied by one address matching thrice.
        assertTrue(fromKeys[0] != fromKeys[1] && fromKeys[1] != fromKeys[2] && fromKeys[0] != fromKeys[2]);
    }

    /// @dev The publisher sorts by recovered signer address; the verifier requires strictly
    ///      ascending. This asserts the fixture really is ascending, so a passing `verify`
    ///      below cannot be explained by the ordering rule silently not being exercised.
    function test_fixtureSignersAreAscending() public pure {
        assertLt(uint160(0x12D1D4587c2D1Eb765bf4DC2f92122443b88c75b), uint160(0x1bE4D27583DD1951B27454cE7871121a4bb2854C));
        assertLt(uint160(0x1bE4D27583DD1951B27454cE7871121a4bb2854C), uint160(0x616d2cBB7165c07ab883D76Da1861971dE111127));
    }

    /// @notice THE test: real publisher bytes, unmodified, accepted by the real verifier.
    function test_verifierAcceptsPublisherBytes() public view {
        bytes memory returned = verifier.verify(SIGNED_REPORT);
        assertEq(returned, REPORT_DATA, "verify must return the payload byte-for-byte");
    }

    /// @dev Field-by-field, because "the bytes round-tripped" would still pass if both sides
    ///      agreed on a WRONG field order. These values are the ones the generator signed.
    ///      The price assertion is the load-bearing one: a wrong exponent never reverts
    ///      anywhere on chain, it just opens positions at the wrong price.
    function test_payloadDecodesToTheSignedFields() public view {
        (
            uint256 chainId,
            address verifierAddr,
            bytes32 feedId,
            uint32 timestamp,
            int192 price,
            int192 bid,
            int192 ask,
            bool isMarketOpen,
            bool isDayTradingClosed
        ) = abi.decode(
            verifier.verify(SIGNED_REPORT),
            (uint256, address, bytes32, uint32, int192, int192, int192, bool, bool)
        );

        assertEq(chainId, CHAIN_ID);
        assertEq(verifierAddr, VERIFIER_ADDR);
        assertEq(feedId, bytes32("BTC/USD"));
        assertEq(timestamp, 1_700_000_000);
        assertEq(price, 65_000e18, "$65,000.00 must carry exactly 18 decimals");
        assertEq(bid, 65_000e18 - 1e18);
        assertEq(ask, 65_000e18 + 1e18);
        assertTrue(isMarketOpen);
        assertFalse(isDayTradingClosed);
    }

    /// @dev Domain separation is not decorative: the same bytes must be worthless on another
    ///      chain. Without this, a report signed for testnet replays onto mainnet.
    function test_publisherBytesRejectedOnAnotherChain() public {
        vm.chainId(CHAIN_ID + 1);
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.WrongChain.selector, CHAIN_ID, CHAIN_ID + 1)
        );
        verifier.verify(SIGNED_REPORT);
    }
}
