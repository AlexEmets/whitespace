// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {Delegatable} from "../../src/vendor/ostium/abstract/Delegatable.sol";

/// @dev Minimal concrete Delegatable: the base is abstract only in its nonce book-keeping,
///      which is irrelevant to the EIP-712 domain. Nothing else is overridden, so
///      `DOMAIN_SEPARATOR()` here is exactly what every Delegatable-inheriting production
///      contract (WhitespaceTrading) exposes.
contract DelegatableHarness is Delegatable {
    mapping(address => uint256) private nonces;

    function _getDelegatableNonce(address delegator) internal view override returns (uint256) {
        return nonces[delegator];
    }

    function _incrementDelegatableNonce(address delegator) internal override {
        nonces[delegator] += 1;
    }
}

/// @notice Pins the EIP-712 delegation domain `name` to the Whitespace brand. A wallet shows
///         this name when signing a `setDelegateWithSignature` delegation, and it is baked into
///         `DOMAIN_SEPARATOR`, so a regression back to the vendored `'Ostium'` name both re-exposes
///         the origin brand in the signing prompt and silently invalidates every existing delegation
///         signature. This test fails against `name = 'Ostium'`.
contract DelegatableDomainTest is Test {
    bytes32 constant TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    DelegatableHarness harness;

    function setUp() public {
        harness = new DelegatableHarness();
    }

    function _domainSeparator(string memory name) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPE_HASH, keccak256(bytes(name)), keccak256(bytes("1")), block.chainid, address(harness)
            )
        );
    }

    function test_DomainName_IsWhitespace() public view {
        assertEq(harness.DOMAIN_SEPARATOR(), _domainSeparator("Whitespace"), "domain name must be Whitespace");
    }

    function test_DomainName_IsNotOstium() public view {
        assertTrue(
            harness.DOMAIN_SEPARATOR() != _domainSeparator("Ostium"),
            "domain must no longer carry the Ostium brand"
        );
    }
}
