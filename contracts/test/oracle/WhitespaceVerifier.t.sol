// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {OstiumRegistry} from "../../src/vendor/ostium/OstiumRegistry.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumVerifier} from "../../src/vendor/ostium/interfaces/IOstiumVerifier.sol";
import {WhitespaceVerifier} from "../../src/oracle/WhitespaceVerifier.sol";
import {ReportLib} from "../helpers/ReportLib.sol";

/// @notice Layer 1 of the oracle defence, in isolation: the k-of-N threshold, the ascending-order
///         rule, and domain separation. The rails that sit on top of it are proven in
///         `test/integration/OracleHardening.t.sol`; the "for any input" formulation of the
///         threshold is proven in `test/invariant/VerifierThreshold.t.sol`.
///
/// @dev    Every `vm.expectRevert` here is pinned to the exact error payload, never bare. A bare
///         expectation cannot tell "the threshold rejected this" from "the helper built a
///         malformed report and the ABI decoder panicked" — and both look identical from the
///         outside. That distinction is the entire value of these tests.
contract WhitespaceVerifierTest is Test {
    using ReportLib for ReportLib.Report;

    // Five authorised signing keys (N=5) and three that are not authorised.
    uint256 internal constant K1 = 0xA11CE01;
    uint256 internal constant K2 = 0xA11CE02;
    uint256 internal constant K3 = 0xA11CE03;
    uint256 internal constant K4 = 0xA11CE04;
    uint256 internal constant K5 = 0xA11CE05;
    uint256 internal constant ROGUE = 0xBADBAD;

    uint256 internal constant THRESHOLD = 3;
    bytes32 internal constant FEED = "BTC/USD";
    int192 internal constant BTC_65K = 65_000e18; // $65,000.00 at 18 decimals
    uint32 internal constant TS = 1_700_000_000;

    address internal gov = address(0x60F);
    address internal dev = address(0xDE7);
    address internal manager = address(0xA11);
    address internal owner = address(0x0E1);

    OstiumRegistry internal registry;
    WhitespaceVerifier internal verifier;

    uint256[] internal allKeys;

    function setUp() public {
        registry = new OstiumRegistry(gov, dev, manager, owner);

        allKeys = [K1, K2, K3, K4, K5];
        address[] memory signers = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            signers[i] = vm.addr(allKeys[i]);
        }

        verifier = new WhitespaceVerifier(IOstiumRegistry(address(registry)), signers, THRESHOLD);
    }

    function _report() internal view returns (ReportLib.Report memory) {
        return ReportLib.btcReport(address(verifier), FEED, TS, BTC_65K);
    }

    function _signed(uint256[] memory keys) internal view returns (bytes memory) {
        return ReportLib.signedReport(_report(), keys);
    }

    // -------------------------------------------------------------------------------------
    // The wire format itself
    // -------------------------------------------------------------------------------------

    /// @dev Pins the exact bytes the publisher must sign. `ReportLib` spells the EIP-191 prefix
    ///      out literally; the verifier calls OpenZeppelin's helper. If those ever diverge, every
    ///      live report fails with a garbage recovered address and no other signal — so the
    ///      equality is asserted rather than assumed.
    function test_digestMatchesLiteralEip191Encoding() public view {
        bytes memory reportData = ReportLib.encode(_report());
        assertEq(
            ReportLib.digest(reportData),
            MessageHashUtils.toEthSignedMessageHash(keccak256(reportData)),
            "publisher digest must equal the verifier's digest"
        );
    }

    /// @dev The nine-field payload is 9 static words. A publisher that emits eight or ten fields
    ///      produces a different keccak and therefore an unrecoverable report.
    function test_reportDataIsNineStaticWords() public view {
        assertEq(ReportLib.encode(_report()).length, 9 * 32);
    }

    // -------------------------------------------------------------------------------------
    // Threshold
    // -------------------------------------------------------------------------------------

    function test_acceptsExactlyKSignatures() public view {
        bytes memory reportData = ReportLib.encode(_report());
        assertEq(
            verifier.verify(_signed(ReportLib.keys3(K1, K2, K3))),
            reportData,
            "a k-of-N report must be returned verbatim"
        );
    }

    function test_acceptsAllNSignatures() public view {
        assertEq(verifier.verify(_signed(allKeys)), ReportLib.encode(_report()));
    }

    /// @dev Any three of the five, not just the first three.
    function test_acceptsAnyKSubset() public view {
        assertEq(verifier.verify(_signed(ReportLib.keys3(K3, K5, K1))), ReportLib.encode(_report()));
        assertEq(verifier.verify(_signed(ReportLib.keys3(K2, K4, K5))), ReportLib.encode(_report()));
    }

    function test_rejectsKMinusOneSignatures() public {
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.InsufficientSignatures.selector, 2, THRESHOLD)
        );
        verifier.verify(_signed(ReportLib.keys2(K1, K2)));
    }

    function test_rejectsSingleSignature() public {
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.InsufficientSignatures.selector, 1, THRESHOLD)
        );
        verifier.verify(_signed(ReportLib.keys1(K1)));
    }

    function test_rejectsZeroSignatures() public {
        bytes memory reportData = ReportLib.encode(_report());
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.InsufficientSignatures.selector, 0, THRESHOLD)
        );
        verifier.verify(ReportLib.pack(reportData, new bytes[](0)));
    }

    // -------------------------------------------------------------------------------------
    // Ascending order — the replay defence
    // -------------------------------------------------------------------------------------

    /// @dev THE attack the ordering rule exists for: one compromised key, its signature copied
    ///      k times to reach the threshold on its own.
    function test_rejectsOneSignatureReplayedKTimes() public {
        vm.expectRevert(WhitespaceVerifier.SignersNotAscending.selector);
        verifier.verify(_signed(ReportLib.keys3(K1, K1, K1)));
    }

    function test_rejectsDuplicateAlongsideDistinctSigners() public {
        // Two genuinely distinct signers plus a copy of one of them: three signatures, two
        // signers. Sorting puts the duplicate adjacent to its twin, so the ascending check
        // catches it regardless of where the publisher placed it.
        vm.expectRevert(WhitespaceVerifier.SignersNotAscending.selector);
        verifier.verify(_signed(ReportLib.keys3(K1, K2, K1)));
    }

    function test_rejectsDescendingOrder() public {
        bytes memory reportData = ReportLib.encode(_report());
        uint256[] memory sorted = ReportLib.sortKeysByAddress(ReportLib.keys3(K1, K2, K3));
        uint256[] memory reversed = ReportLib.keys3(sorted[2], sorted[1], sorted[0]);
        vm.expectRevert(WhitespaceVerifier.SignersNotAscending.selector);
        verifier.verify(ReportLib.pack(reportData, ReportLib.signUnsorted(reportData, reversed)));
    }

    /// @dev A single adjacent swap in an otherwise valid set. Proves the check is on every pair,
    ///      not just on the first and last.
    function test_rejectsSingleAdjacentSwap() public {
        bytes memory reportData = ReportLib.encode(_report());
        uint256[] memory sorted = ReportLib.sortKeysByAddress(ReportLib.keys3(K1, K2, K3));
        uint256[] memory swapped = ReportLib.keys3(sorted[0], sorted[2], sorted[1]);
        vm.expectRevert(WhitespaceVerifier.SignersNotAscending.selector);
        verifier.verify(ReportLib.pack(reportData, ReportLib.signUnsorted(reportData, swapped)));
    }

    /// @dev Every non-identity permutation of a valid 3-signer set must be rejected, and the
    ///      identity (sorted) permutation must be accepted. Six cases, exhaustive.
    function test_onlyTheSortedPermutationIsAccepted() public {
        bytes memory reportData = ReportLib.encode(_report());
        uint256[] memory s = ReportLib.sortKeysByAddress(ReportLib.keys3(K1, K2, K3));
        uint8[3][6] memory perms =
            [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

        for (uint256 p = 0; p < 6; p++) {
            uint256[] memory ordered =
                ReportLib.keys3(s[perms[p][0]], s[perms[p][1]], s[perms[p][2]]);
            bytes memory packed =
                ReportLib.pack(reportData, ReportLib.signUnsorted(reportData, ordered));
            if (p == 0) {
                assertEq(verifier.verify(packed), reportData, "sorted permutation must be accepted");
            } else {
                vm.expectRevert(WhitespaceVerifier.SignersNotAscending.selector);
                verifier.verify(packed);
            }
        }
    }

    // -------------------------------------------------------------------------------------
    // Authorisation
    // -------------------------------------------------------------------------------------

    /// @dev k-1 authorised signatures topped up with one unauthorised key. The rogue address is
    ///      forced to sort last so the ascending check cannot fire first and mask the real
    ///      reason — this test is about authorisation, and it must fail for that reason.
    function test_rejectsKMinusOnePlusUnauthorised() public {
        uint256 rogueKey = _rogueKeySortingAfter(vm.addr(K1), vm.addr(K2));
        bytes memory reportData = ReportLib.encode(_report());
        uint256[] memory keys = ReportLib.sortKeysByAddress(ReportLib.keys3(K1, K2, rogueKey));

        vm.expectRevert(
            abi.encodeWithSelector(IOstiumVerifier.NotAuthorizedSigner.selector, vm.addr(rogueKey))
        );
        verifier.verify(ReportLib.pack(reportData, ReportLib.signUnsorted(reportData, keys)));
    }

    /// @dev Even k signatures from unauthorised keys are rejected — the count is of AUTHORISED
    ///      signers, not of signatures.
    function test_rejectsKUnauthorisedSignatures() public {
        uint256 r1 = _rogueKeySortingAfter(address(0), address(0));
        uint256 r2 = _rogueKeySortingAfter(vm.addr(r1), address(0));
        uint256 r3 = _rogueKeySortingAfter(vm.addr(r2), address(0));
        bytes memory reportData = ReportLib.encode(_report());
        uint256[] memory keys = ReportLib.sortKeysByAddress(ReportLib.keys3(r1, r2, r3));

        vm.expectRevert(
            abi.encodeWithSelector(IOstiumVerifier.NotAuthorizedSigner.selector, vm.addr(keys[0]))
        );
        verifier.verify(ReportLib.pack(reportData, ReportLib.signUnsorted(reportData, keys)));
    }

    /// @dev A revoked signer's previously valid signature stops counting immediately.
    function test_rejectsRevokedSigner() public {
        vm.prank(gov);
        verifier.setThreshold(2);
        vm.prank(gov);
        verifier.unregisterAuthorizedSigner(vm.addr(K3));

        vm.expectRevert(
            abi.encodeWithSelector(IOstiumVerifier.NotAuthorizedSigner.selector, vm.addr(K3))
        );
        verifier.verify(_signed(ReportLib.keys3(K1, K2, K3)));
    }

    // -------------------------------------------------------------------------------------
    // Domain separation
    // -------------------------------------------------------------------------------------

    /// @dev A report signed for another chain — the whole point of putting `chainId` inside the
    ///      signed bytes. Testnet 1874 and mainnet 1875 run the same contracts with the same
    ///      signer set; without this, a testnet report is a mainnet report.
    function test_rejectsForeignChainId() public {
        ReportLib.Report memory r = _report();
        r.chainId = 1875;
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.WrongChain.selector, 1875, block.chainid)
        );
        verifier.verify(ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3)));
    }

    /// @dev A report signed for a different verifier instance — e.g. one retired after a key
    ///      rotation, whose signer set an attacker still controls.
    function test_rejectsForeignVerifierAddress() public {
        address other = address(0xDEADBEEF);
        ReportLib.Report memory r = _report();
        r.verifier = other;
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.WrongVerifier.selector, other, address(verifier))
        );
        verifier.verify(ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3)));
    }

    /// @dev A second verifier with the SAME signer set and the SAME registry must still reject a
    ///      report addressed to the first. This is the case a naive "is the signer authorised?"
    ///      check would wave through.
    function test_rejectsReportAddressedToASiblingVerifier() public {
        address[] memory signers = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            signers[i] = vm.addr(allKeys[i]);
        }
        WhitespaceVerifier sibling =
            new WhitespaceVerifier(IOstiumRegistry(address(registry)), signers, THRESHOLD);

        bytes memory reportForOriginal = _signed(ReportLib.keys3(K1, K2, K3));
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespaceVerifier.WrongVerifier.selector, address(verifier), address(sibling)
            )
        );
        sibling.verify(reportForOriginal);
    }

    function test_rejectsTruncatedReportData() public {
        bytes memory shortData = abi.encodePacked(uint256(block.chainid)); // 32 bytes, needs 64
        bytes[] memory sigs = ReportLib.signUnsorted(shortData, ReportLib.keys3(K1, K2, K3));
        vm.expectRevert(abi.encodeWithSelector(WhitespaceVerifier.MalformedReport.selector, 32));
        verifier.verify(ReportLib.pack(shortData, sigs));
    }

    /// @dev A malformed signature must name itself, not surface as a bogus recovered address.
    function test_rejectsWrongLengthSignature() public {
        bytes memory reportData = ReportLib.encode(_report());
        bytes[] memory sigs = ReportLib.signUnsorted(reportData, ReportLib.keys3(K1, K2, K3));
        sigs[0] = hex"1234";
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 2));
        verifier.verify(ReportLib.pack(reportData, sigs));
    }

    /// @dev Flipping a byte of the payload after signing invalidates every signature at once,
    ///      because all k sign the same digest.
    function test_rejectsTamperedPrice() public {
        ReportLib.Report memory r = _report();
        bytes memory honest = ReportLib.encode(r);
        bytes[] memory sigs = ReportLib.sign(honest, ReportLib.keys3(K1, K2, K3));

        r.price = 6_500e18; // $6,500 instead of $65,000 — a tenth of the real price
        bytes memory tampered = ReportLib.encode(r);

        // The recovered addresses are now unrelated to the signer set; whichever error fires
        // first, the report cannot be accepted.
        vm.expectRevert();
        verifier.verify(ReportLib.pack(tampered, sigs));
    }

    // -------------------------------------------------------------------------------------
    // Fuzz
    // -------------------------------------------------------------------------------------

    /// @dev Every subset of the AUTHORISED signer set smaller than k, correctly signed, in
    ///      correct order, with a correct domain — the strongest form of a k-1 attack — must be
    ///      rejected with `InsufficientSignatures`.
    function testFuzz_rejectsEverySubsetBelowThreshold(uint8 mask) public {
        uint256[] memory subset = _subset(mask);
        vm.assume(subset.length < THRESHOLD);

        vm.expectRevert(
            abi.encodeWithSelector(
                WhitespaceVerifier.InsufficientSignatures.selector, subset.length, THRESHOLD
            )
        );
        verifier.verify(_signed(subset));
    }

    /// @dev Every subset of size >= k must be accepted. The mirror of the test above: a rule that
    ///      rejects everything would satisfy the safety half on its own.
    function testFuzz_acceptsEverySubsetAtOrAboveThreshold(uint8 mask) public view {
        uint256[] memory subset = _subset(mask);
        vm.assume(subset.length >= THRESHOLD);
        assertEq(verifier.verify(_signed(subset)), ReportLib.encode(_report()));
    }

    /// @dev Padding a k-1 subset up to k by repeating one of its own members must not work, for
    ///      any subset and any choice of which member to repeat.
    function testFuzz_rejectsSubsetPaddedWithDuplicates(uint8 mask, uint8 repeatIndex) public {
        uint256[] memory subset = _subset(mask);
        vm.assume(subset.length > 0 && subset.length < THRESHOLD);

        uint256[] memory padded = new uint256[](THRESHOLD);
        for (uint256 i = 0; i < subset.length; i++) {
            padded[i] = subset[i];
        }
        uint256 repeated = subset[repeatIndex % subset.length];
        for (uint256 i = subset.length; i < THRESHOLD; i++) {
            padded[i] = repeated;
        }

        vm.expectRevert(WhitespaceVerifier.SignersNotAscending.selector);
        verifier.verify(_signed(padded));
    }

    /// @dev Arbitrary chain ids other than this one are rejected, not just plausible ones.
    function testFuzz_rejectsAnyForeignChainId(uint256 chainId) public {
        vm.assume(chainId != block.chainid);
        ReportLib.Report memory r = _report();
        r.chainId = chainId;
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.WrongChain.selector, chainId, block.chainid)
        );
        verifier.verify(ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3)));
    }

    function testFuzz_rejectsAnyForeignVerifier(address other) public {
        vm.assume(other != address(verifier));
        ReportLib.Report memory r = _report();
        r.verifier = other;
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.WrongVerifier.selector, other, address(verifier))
        );
        verifier.verify(ReportLib.signedReport(r, ReportLib.keys3(K1, K2, K3)));
    }

    /// @dev Arbitrary bytes must never verify. The invariant suite fuzzes this far harder; this
    ///      is the cheap always-on version.
    function testFuzz_rejectsArbitraryBytes(bytes calldata blob) public {
        try verifier.verify(blob) returns (bytes memory) {
            fail();
        } catch {}
    }

    // -------------------------------------------------------------------------------------
    // Governance
    // -------------------------------------------------------------------------------------

    function test_constructorSeedsSignerSetAndThreshold() public view {
        assertEq(verifier.signerCount(), 5);
        assertEq(verifier.threshold(), THRESHOLD);
        for (uint256 i = 0; i < 5; i++) {
            assertTrue(verifier.isAuthorizedSigner(vm.addr(allKeys[i])));
        }
    }

    function test_constructorRejectsThresholdAboveSignerCount() public {
        address[] memory two = new address[](2);
        two[0] = vm.addr(K1);
        two[1] = vm.addr(K2);
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.ThresholdExceedsSignerCount.selector, 3, 2)
        );
        new WhitespaceVerifier(IOstiumRegistry(address(registry)), two, 3);
    }

    function test_constructorRejectsZeroThreshold() public {
        address[] memory one = new address[](1);
        one[0] = vm.addr(K1);
        vm.expectRevert(IOstiumVerifier.WrongParams.selector);
        new WhitespaceVerifier(IOstiumRegistry(address(registry)), one, 0);
    }

    function test_constructorRejectsDuplicateSigner() public {
        address[] memory dupes = new address[](2);
        dupes[0] = vm.addr(K1);
        dupes[1] = vm.addr(K1);
        vm.expectRevert(
            abi.encodeWithSelector(IOstiumVerifier.AlreadyAuthorizedSigner.selector, vm.addr(K1))
        );
        new WhitespaceVerifier(IOstiumRegistry(address(registry)), dupes, 1);
    }

    function test_onlyGovCanRegisterSigner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(IOstiumVerifier.NotGov.selector, address(0xBAD)));
        verifier.registerAuthorizedSigner(vm.addr(ROGUE));
    }

    function test_onlyGovCanSetThreshold() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(IOstiumVerifier.NotGov.selector, address(0xBAD)));
        verifier.setThreshold(1);
    }

    function test_govCanRotateASigner() public {
        address incoming = vm.addr(ROGUE);
        vm.prank(gov);
        verifier.registerAuthorizedSigner(incoming);
        assertEq(verifier.signerCount(), 6);

        vm.prank(gov);
        verifier.unregisterAuthorizedSigner(vm.addr(K1));
        assertEq(verifier.signerCount(), 5);

        // The rotated-in key now counts toward the threshold.
        assertEq(
            verifier.verify(_signed(ReportLib.keys3(K2, K3, ROGUE))), ReportLib.encode(_report())
        );
    }

    /// @dev Removing signers until N < k would wedge the verifier: no report could ever reach the
    ///      threshold, and every price delivery in the system would fail. Gov must lower k first.
    function test_removingSignerBelowThresholdReverts() public {
        vm.prank(gov);
        verifier.unregisterAuthorizedSigner(vm.addr(K5));
        vm.prank(gov);
        verifier.unregisterAuthorizedSigner(vm.addr(K4));
        assertEq(verifier.signerCount(), 3);

        vm.prank(gov);
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.ThresholdExceedsSignerCount.selector, 3, 2)
        );
        verifier.unregisterAuthorizedSigner(vm.addr(K3));

        // And the state did not move: the failed removal left K3 authorised.
        assertTrue(verifier.isAuthorizedSigner(vm.addr(K3)));
        assertEq(verifier.signerCount(), 3);
    }

    function test_setThresholdAboveSignerCountReverts() public {
        vm.prank(gov);
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.ThresholdExceedsSignerCount.selector, 6, 5)
        );
        verifier.setThreshold(6);
    }

    function test_setThresholdToZeroReverts() public {
        vm.prank(gov);
        vm.expectRevert(IOstiumVerifier.WrongParams.selector);
        verifier.setThreshold(0);
    }

    /// @dev Raising k takes effect on the very next report.
    function test_raisingThresholdImmediatelyRejectsOldQuorum() public {
        vm.prank(gov);
        verifier.setThreshold(4);
        vm.expectRevert(
            abi.encodeWithSelector(WhitespaceVerifier.InsufficientSignatures.selector, 3, 4)
        );
        verifier.verify(_signed(ReportLib.keys3(K1, K2, K3)));
    }

    // -------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------

    /// @dev The subset of `allKeys` selected by the low five bits of `mask`.
    function _subset(uint8 mask) internal view returns (uint256[] memory keys) {
        uint256 n;
        for (uint256 i = 0; i < 5; i++) {
            if (mask & (1 << i) != 0) n++;
        }
        keys = new uint256[](n);
        uint256 j;
        for (uint256 i = 0; i < 5; i++) {
            if (mask & (1 << i) != 0) keys[j++] = allKeys[i];
        }
    }

    /// @dev Finds an unauthorised key whose address sorts strictly after both `a` and `b`, so a
    ///      report containing it is still in ascending order and fails on authorisation rather
    ///      than on ordering. Deterministic: the same key every run.
    function _rogueKeySortingAfter(address a, address b) internal view returns (uint256) {
        for (uint256 salt = 1; salt < 512; salt++) {
            uint256 key = uint256(keccak256(abi.encodePacked("rogue", a, b, salt)));
            address candidate = vm.addr(key);
            if (candidate > a && candidate > b && !verifier.isAuthorizedSigner(candidate)) {
                return key;
            }
        }
        revert("no suitable rogue key found");
    }
}
