// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {OstiumRegistry} from "../../src/vendor/ostium/OstiumRegistry.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {WhitespaceVerifier} from "../../src/oracle/WhitespaceVerifier.sol";
import {ReportLib} from "../helpers/ReportLib.sol";

/// @notice Design spec §8, invariant 5: **`verify()` never accepts a report with fewer than k
///         valid, distinct, authorised signatures — for any input.**
///
/// @dev    The handler builds reports from a signer set whose GROUND TRUTH it knows: it chooses
///         a subset of the five authorised keys by bitmask, so `popcount(mask)` is the exact
///         number of distinct authorised signers on the report, computed WITHOUT asking the
///         verifier. The invariant then reads: if `verify` returned, that number was >= k.
///
///         Stating it that way is what keeps the test from being circular. A handler that
///         recomputed the signer set by running `ecrecover` itself would just be re-implementing
///         `verify` and asserting it equals itself; this one derives the answer from the inputs
///         it chose before any contract was called.
///
///         Rejections alone prove nothing — a `verify` that reverted unconditionally would
///         satisfy the invariant perfectly. `afterInvariant` therefore asserts the handler
///         actually reached acceptance during the run, and `test_handlerReachesAcceptance`
///         pins the same property deterministically in case this forge version does not call
///         `afterInvariant`.
contract VerifierThresholdInvariantTest is Test {
    uint256 internal constant THRESHOLD = 3;

    OstiumRegistry internal registry;
    WhitespaceVerifier internal verifier;
    VerifyHandler internal handler;

    function setUp() public {
        registry = new OstiumRegistry(address(0x60F), address(0xDE7), address(0xA11), address(0x0E1));

        uint256[5] memory authorized =
            [uint256(0xA11CE01), 0xA11CE02, 0xA11CE03, 0xA11CE04, 0xA11CE05];
        address[] memory signers = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            signers[i] = vm.addr(authorized[i]);
        }

        verifier = new WhitespaceVerifier(IOstiumRegistry(address(registry)), signers, THRESHOLD);
        handler = new VerifyHandler(verifier, authorized, [uint256(0xBAD01), 0xBAD02, 0xBAD03]);

        targetContract(address(handler));
    }

    /// @notice Invariant 5. No accepted report ever carried fewer than k distinct authorised
    ///         signatures.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 128
    function invariant_neverAcceptsBelowThreshold() public view {
        assertFalse(
            handler.acceptedBelowThreshold(),
            "verify() accepted a report with fewer than k distinct authorised signers"
        );
    }

    /// @notice Corollary: no accepted report ever carried a signature from a key outside the
    ///         authorised set.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 128
    function invariant_neverAcceptsUnauthorisedSigner() public view {
        assertFalse(
            handler.acceptedWithUnauthorised(), "verify() accepted an unauthorised signature"
        );
    }

    /// @notice Corollary: no accepted report ever repeated a signer to reach the threshold.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 128
    function invariant_neverAcceptsDuplicateSigner() public view {
        assertFalse(handler.acceptedWithDuplicate(), "verify() accepted a duplicated signer");
    }

    /// @notice Corollary: no accepted report was addressed to another chain or another verifier.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 128
    function invariant_neverAcceptsWrongDomain() public view {
        assertFalse(
            handler.acceptedWithWrongDomain(), "verify() accepted a report for a foreign domain"
        );
    }

    /// @notice Corollary: arbitrary calldata never verifies.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 128
    function invariant_neverAcceptsArbitraryBytes() public view {
        assertFalse(handler.acceptedRawBlob(), "verify() accepted an unsigned blob");
    }

    /// @dev The coverage floor. Without it, every invariant above is satisfied by a `verify`
    ///      that rejects everything, which is exactly the bug an oracle test must not miss.
    function afterInvariant() public view {
        assertGt(handler.acceptedCount(), 0, "the campaign never produced an accepted report");
        assertGt(handler.rejectedCount(), 0, "the campaign never produced a rejected report");
    }

    /// @dev Same floor, deterministically, so it holds even if this forge version never calls
    ///      `afterInvariant`. Mask 0b00111 selects the first three authorised keys; mode 0 means
    ///      no corruption; `orderSeed = 0` means sorted.
    function test_handlerReachesAcceptance() public {
        handler.submit({
            signerMask: 0x07,
            mode: 0,
            orderSeed: 0,
            timestamp: 1_700_000_000,
            price: 65_000e18
        });
        assertEq(handler.acceptedCount(), 1, "a clean 3-of-5 report must be accepted");
        assertFalse(handler.acceptedBelowThreshold());
    }

    /// @dev And the mirror: mask 0b00011 is two signers, below k, so it must be rejected — with
    ///      the flag staying clear, proving the flag tracks acceptance and not merely the call.
    function test_handlerReachesRejection() public {
        handler.submit({
            signerMask: 0x03,
            mode: 0,
            orderSeed: 0,
            timestamp: 1_700_000_000,
            price: 65_000e18
        });
        assertEq(handler.acceptedCount(), 0);
        assertEq(handler.rejectedCount(), 1);
        assertFalse(handler.acceptedBelowThreshold());
    }
}

/// @notice Drives `verify()` with reports whose true signer composition the handler knows.
/// @dev    Corruption is applied through a single `mode` selector rather than through several
///         independent booleans. With independent booleans the probability of a CLEAN report
///         falls off geometrically in the number of axes, and the campaign spends almost all of
///         its calls on rejections — which would leave the coverage floor in `afterInvariant`
///         flaky and, worse, would leave the accept path barely explored. One selector keeps
///         P(clean) at 1/2 while still reaching each corruption about an eighth of the time.
contract VerifyHandler {
    WhitespaceVerifier public immutable verifier;
    uint256 public immutable threshold;

    uint256[5] internal authorizedKeys;
    uint256[3] internal rogueKeys;

    uint256 public acceptedCount;
    uint256 public rejectedCount;

    bool public acceptedBelowThreshold;
    bool public acceptedWithUnauthorised;
    bool public acceptedWithDuplicate;
    bool public acceptedWithWrongDomain;
    bool public acceptedRawBlob;

    constructor(WhitespaceVerifier _verifier, uint256[5] memory _authorized, uint256[3] memory _rogue) {
        verifier = _verifier;
        threshold = _verifier.threshold();
        authorizedKeys = _authorized;
        rogueKeys = _rogue;
    }

    /// @param signerMask Low five bits select which of the five AUTHORISED keys sign.
    ///                   `popcount` of these bits is the ground truth this test turns on.
    /// @param mode       0-3: clean. 4: foreign chainId. 5: foreign verifier. 6: add an
    ///                   unauthorised signature. 7: repeat the first signer.
    /// @param orderSeed  `% 4 == 3` submits the signatures unsorted.
    function submit(uint8 signerMask, uint8 mode, uint8 orderSeed, uint32 timestamp, int192 price)
        external
    {
        uint8 corruption = mode % 8;
        bool withRogue = corruption == 6;
        bool withDuplicate = corruption == 7;

        uint256 distinctAuthorised = _popcount5(signerMask);
        uint256[] memory keys = _keys(signerMask, withRogue, withDuplicate);

        ReportLib.Report memory r = ReportLib.Report({
            chainId: corruption == 4 ? block.chainid + 1 : block.chainid,
            verifier: corruption == 5 ? address(this) : address(verifier),
            feedId: "BTC/USD",
            timestamp: timestamp,
            price: price,
            bid: price,
            ask: price,
            isMarketOpen: true,
            isDayTradingClosed: false
        });

        bytes memory reportData = ReportLib.encode(r);
        bytes[] memory signatures = orderSeed % 4 == 3
            ? ReportLib.signUnsorted(reportData, keys)
            : ReportLib.sign(reportData, keys);

        try verifier.verify(ReportLib.pack(reportData, signatures)) returns (bytes memory) {
            acceptedCount++;
            if (distinctAuthorised < threshold) acceptedBelowThreshold = true;
            if (withRogue) acceptedWithUnauthorised = true;
            if (withDuplicate && keys.length > 1) acceptedWithDuplicate = true;
            if (corruption == 4 || corruption == 5) acceptedWithWrongDomain = true;
        } catch {
            rejectedCount++;
        }
    }

    /// @notice Arbitrary calldata. Ground truth is zero authorised signatures, always.
    function submitRaw(bytes calldata blob) external {
        try verifier.verify(blob) returns (bytes memory) {
            acceptedCount++;
            acceptedRawBlob = true;
            acceptedBelowThreshold = true;
        } catch {
            rejectedCount++;
        }
    }

    /// @notice A report whose signatures were produced over a DIFFERENT payload than the one
    ///         submitted. Ground truth is again zero: none of them signs this report.
    function submitCrossSigned(uint8 signerMask, uint32 timestampA, uint32 timestampB, int192 price)
        external
    {
        if (timestampA == timestampB) return;
        uint256[] memory keys = _keys(signerMask, false, false);

        ReportLib.Report memory r = ReportLib.Report({
            chainId: block.chainid,
            verifier: address(verifier),
            feedId: "BTC/USD",
            timestamp: timestampA,
            price: price,
            bid: price,
            ask: price,
            isMarketOpen: true,
            isDayTradingClosed: false
        });
        bytes[] memory signatures = ReportLib.sign(ReportLib.encode(r), keys);

        r.timestamp = timestampB; // swap the payload out from under the signatures
        try verifier.verify(ReportLib.pack(ReportLib.encode(r), signatures)) returns (bytes memory) {
            acceptedCount++;
            acceptedBelowThreshold = true;
        } catch {
            rejectedCount++;
        }
    }

    function _keys(uint8 signerMask, bool withRogue, bool withDuplicate)
        internal
        view
        returns (uint256[] memory keys)
    {
        uint256 n = _popcount5(signerMask);
        uint256 extra = (withRogue ? 1 : 0) + (withDuplicate && n > 0 ? 1 : 0);
        keys = new uint256[](n + extra);

        uint256 j;
        for (uint256 i = 0; i < 5; i++) {
            if (signerMask & (1 << i) != 0) keys[j++] = authorizedKeys[i];
        }
        if (withRogue) keys[j++] = rogueKeys[uint256(signerMask) % 3];
        if (withDuplicate && n > 0) keys[j++] = keys[0];
    }

    function _popcount5(uint8 mask) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < 5; i++) {
            if (mask & (1 << i) != 0) n++;
        }
    }
}
