// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IOstiumVerifier} from "../vendor/ostium/interfaces/IOstiumVerifier.sol";
import {IOstiumRegistry} from "../vendor/ostium/interfaces/IOstiumRegistry.sol";

/// @title  WhitespaceVerifier — k-of-N threshold price-report verification
/// @notice Drop-in replacement for the vendored `OstiumVerifier` under the registry's
///         `ostiumVerifier` key. Implements `IOstiumVerifier`, so every existing consumer
///         (`OstiumPrivatePriceUpKeep`, `WhitespacePriceUpKeep`, `Operate.s.sol`) keeps
///         working against the same external surface.
///
/// @dev    **Layer 1 of the two-layer oracle defence** (design spec §6.2). The vendored
///         verifier recovers ONE signature and checks one allowlist entry: a single key
///         compromise is a total compromise of every market's price. On Arbitrum, Ostium has
///         Chainlink standing beside that key as an independent source. On Whitechain there is
///         nothing, so the threshold has to carry the whole weight.
///
///         This layer defends against **key compromise only**. It is powerless against N honest
///         signers fed the same wrong input — they will all honestly sign the same falsehood.
///         That case is caught by layer 2, the deviation/staleness rails in
///         `WhitespacePriceUpKeep`, which do not ask *who* signed but whether the *number* is
///         plausible. Neither layer subsumes the other; see spec §6.4.
///
/// ### Wire format (fixed — the publisher encodes exactly this)
///
/// ```
/// reportData = abi.encode(
///     uint256 chainId,            // must equal block.chainid
///     address verifier,           // must equal address(this)
///     bytes32 feedId,
///     uint32  timestamp,
///     int192  price,              // 18 decimals
///     int192  bid,
///     int192  ask,
///     bool    isMarketOpen,
///     bool    isDayTradingClosed
/// )
/// signedReport = abi.encode(bytes reportData, bytes[] signatures)  // each 65 bytes, r||s||v
/// digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(reportData)))
/// ```
///
/// `chainId` and `verifier` are domain separation: a report signed for testnet 1874 is
/// unusable on mainnet 1875, and a report signed for a retired verifier instance is unusable
/// against its replacement. Both are inside the signed bytes, so neither can be rewritten by
/// whoever relays the report.
///
/// This verifier only reads the first two words of `reportData`; the remaining seven are the
/// upkeep's business. It returns `reportData` verbatim on success, exactly as the vendored
/// verifier does.
contract WhitespaceVerifier is IOstiumVerifier {
    /// @dev Immutable, unlike the vendored contract's mutable `registry`: nothing upstream ever
    ///      writes it, and gov authority is read through it on every privileged call.
    IOstiumRegistry public immutable registry;

    mapping(address => bool) public isAuthorizedSigner;

    /// @notice N — how many distinct addresses are currently authorised to sign reports.
    uint256 public signerCount;

    /// @notice k — how many distinct authorised signatures a report must carry. Initial: 3.
    uint256 public threshold;

    event ThresholdUpdated(uint256 threshold, uint256 signerCount);

    /// @notice Signatures must be ordered by strictly ascending recovered signer address.
    /// @dev This single check does double duty. It rejects the same signature (or a malleable
    ///      re-encoding of it, which recovers to the same address) replayed k times to reach the
    ///      threshold, and it makes duplicate detection O(n) instead of O(n^2) — no set, no
    ///      nested loop, no per-call storage writes. The publisher must sort; that is cheap
    ///      off-chain and unforgeable on-chain.
    error SignersNotAscending();
    error InsufficientSignatures(uint256 got, uint256 required);
    error WrongChain(uint256 got, uint256 expected);
    error WrongVerifier(address got, address expected);
    /// @dev Raised instead of silently wedging the verifier: with `threshold > signerCount` no
    ///      report can ever reach the threshold, so every price delivery fails and the exchange
    ///      is dead until gov notices. Both `setThreshold` and signer removal check it.
    error ThresholdExceedsSignerCount(uint256 threshold, uint256 signerCount);
    error MalformedReport(uint256 length);

    modifier onlyGov() {
        _onlyGov(msg.sender);
        _;
    }

    function _onlyGov(address a) private view {
        if (a != registry.gov()) revert NotGov(a);
    }

    /// @param _registry     The system registry; `gov()` on it governs this contract.
    /// @param initialSigners The initial authorised signer set (N). Order does not matter here;
    ///                       ordering is a per-report requirement, not a registration one.
    /// @param initialThreshold The initial k. Must be in `[1, initialSigners.length]`.
    /// @dev The constructor seeds the signer set directly rather than going through the
    ///      `onlyGov` registration path, because the deploying account is not gov and a verifier
    ///      that exists with an empty signer set is a verifier that accepts nothing. The trust
    ///      decision is therefore not "who deployed this" but "gov pointed the registry's
    ///      `ostiumVerifier` key at it" — gov must read `signerCount`/`threshold`/
    ///      `isAuthorizedSigner` off the deployed instance before adopting it.
    constructor(IOstiumRegistry _registry, address[] memory initialSigners, uint256 initialThreshold) {
        if (address(_registry) == address(0)) revert WrongParams();
        registry = _registry;

        for (uint256 i = 0; i < initialSigners.length; i++) {
            _addSigner(initialSigners[i]);
        }
        _setThreshold(initialThreshold);
    }

    // ---------------------------------------------------------------------------------------
    // Verification
    // ---------------------------------------------------------------------------------------

    /// @notice Verify a threshold-signed price report and return its payload.
    /// @param  signedReport `abi.encode(bytes reportData, bytes[] signatures)`.
    /// @return reportData The verbatim signed payload, for the caller to decode.
    /// @dev Declared `view` (the interface declares it non-payable; restricting mutability on
    ///      an implementation is allowed, and the vendored verifier does the same). Nothing
    ///      here writes storage: replay protection for a *specific order* is the upkeep's job
    ///      via the recorded `order.timestamp`, and it must stay that way — a nonce here would
    ///      make `verify` non-view and break every consumer that staticcalls it.
    ///
    ///      Any signature from a non-authorised signer rejects the WHOLE report rather than
    ///      being skipped and not counted. Skipping would let a relayer pad a k-1 report with
    ///      garbage and learn nothing; rejecting makes the failure loud and names the address.
    function verify(bytes calldata signedReport) external view returns (bytes memory reportData) {
        bytes[] memory signatures;
        (reportData, signatures) = abi.decode(signedReport, (bytes, bytes[]));

        uint256 required = threshold;
        if (signatures.length < required) {
            revert InsufficientSignatures(signatures.length, required);
        }

        // The two domain-separation words. `abi.decode` of a prefix of a static-type tuple is
        // exact: it reads the first two 32-byte words and ignores the rest, and it reverts if
        // the `address` word has dirty high bits. The length floor turns a truncated payload
        // into a named error instead of a bare decoder panic.
        if (reportData.length < 64) revert MalformedReport(reportData.length);
        (uint256 reportChainId, address reportVerifier) = abi.decode(reportData, (uint256, address));
        if (reportChainId != block.chainid) revert WrongChain(reportChainId, block.chainid);
        if (reportVerifier != address(this)) revert WrongVerifier(reportVerifier, address(this));

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(reportData));

        // Strictly ascending recovered signers => all distinct. Combined with "every signature
        // must be authorised" and the length floor above, `signatures.length >= required` is
        // therefore exactly "at least k distinct authorised signers".
        address previous = address(0);
        for (uint256 i = 0; i < signatures.length; i++) {
            // Reverts ECDSAInvalidSignatureLength / ECDSAInvalidSignature / ECDSAInvalidSignatureS
            // on a malformed signature — never returns address(0) silently.
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= previous) revert SignersNotAscending();
            if (!isAuthorizedSigner[signer]) revert NotAuthorizedSigner(signer);
            previous = signer;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Governance — `registry.gov()`, matching the vendored verifier
    // ---------------------------------------------------------------------------------------

    function registerAuthorizedSigner(address signerAddress) public onlyGov {
        _addSigner(signerAddress);
    }

    function registerAuthorizedSignersArray(address[] calldata signerAddresses) external onlyGov {
        for (uint256 i = 0; i < signerAddresses.length; i++) {
            _addSigner(signerAddresses[i]);
        }
    }

    function unregisterAuthorizedSigner(address signerAddress) public onlyGov {
        _removeSigner(signerAddress);
    }

    function unregisterAuthorizedSignersArray(address[] calldata signerAddresses) external onlyGov {
        for (uint256 i = 0; i < signerAddresses.length; i++) {
            _removeSigner(signerAddresses[i]);
        }
    }

    /// @notice Set k. Lower it before removing signers, raise it after adding them.
    function setThreshold(uint256 newThreshold) external onlyGov {
        _setThreshold(newThreshold);
    }

    function _addSigner(address signerAddress) private {
        if (signerAddress == address(0)) revert WrongParams();
        if (isAuthorizedSigner[signerAddress]) revert AlreadyAuthorizedSigner(signerAddress);
        isAuthorizedSigner[signerAddress] = true;
        signerCount++;
        emit AuthorizedSignerAdded(signerAddress);
    }

    function _removeSigner(address signerAddress) private {
        if (!isAuthorizedSigner[signerAddress]) revert NotAuthorizedSigner(signerAddress);
        delete isAuthorizedSigner[signerAddress];
        uint256 remaining = signerCount - 1;
        // Refuse to strand the verifier below its own threshold; gov must lower k first.
        if (threshold > remaining) revert ThresholdExceedsSignerCount(threshold, remaining);
        signerCount = remaining;
        emit AuthorizedSignerRemoved(signerAddress);
    }

    function _setThreshold(uint256 newThreshold) private {
        if (newThreshold == 0) revert WrongParams();
        uint256 count = signerCount;
        if (newThreshold > count) revert ThresholdExceedsSignerCount(newThreshold, count);
        threshold = newThreshold;
        emit ThresholdUpdated(newThreshold, count);
    }
}
