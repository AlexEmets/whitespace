// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @notice The publisher's wire format, expressed once, in Solidity, so every test in this
///         phase encodes and signs reports the same way.
/// @dev    This library IS the contract between the price publisher (`packages/publisher/`,
///         built independently) and `WhitespaceVerifier`. If the two ever disagree, a live
///         report is rejected with a recovered address that looks like noise — the single most
///         confusing failure mode in the system — so the encoding is written out field by field
///         here rather than derived from a struct the compiler might reorder.
///
/// ```
/// reportData   = abi.encode(uint256 chainId, address verifier, bytes32 feedId, uint32 timestamp,
///                           int192 price, int192 bid, int192 ask, bool isMarketOpen,
///                           bool isDayTradingClosed)
/// signedReport = abi.encode(bytes reportData, bytes[] signatures)   // each 65 bytes, r||s||v
/// digest       = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32",
///                                           keccak256(reportData)))
/// ```
///
/// `digest` is spelled out literally below rather than delegated to OpenZeppelin's
/// `MessageHashUtils.toEthSignedMessageHash`, which is what the verifier uses. A test that
/// reuses the implementation's own helper cannot detect that helper changing meaning;
/// `test_digestMatchesLiteralEip191Encoding` asserts the two agree.
library ReportLib {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @param price 18 decimals. BTC at $65,000.00 is 65_000e18, NOT 65_000e8.
    struct Report {
        uint256 chainId;
        address verifier;
        bytes32 feedId;
        uint32 timestamp;
        int192 price;
        int192 bid;
        int192 ask;
        bool isMarketOpen;
        bool isDayTradingClosed;
    }

    /// @notice A well-formed BTC/USD report: correct domain, 1e18-wide bid/ask, market open.
    function btcReport(address verifier, bytes32 feedId, uint32 timestamp, int192 price)
        internal
        view
        returns (Report memory)
    {
        return Report({
            chainId: block.chainid,
            verifier: verifier,
            feedId: feedId,
            timestamp: timestamp,
            price: price,
            bid: price - 1e18,
            ask: price + 1e18,
            isMarketOpen: true,
            isDayTradingClosed: false
        });
    }

    function encode(Report memory r) internal pure returns (bytes memory) {
        return abi.encode(
            r.chainId,
            r.verifier,
            r.feedId,
            r.timestamp,
            r.price,
            r.bid,
            r.ask,
            r.isMarketOpen,
            r.isDayTradingClosed
        );
    }

    function digest(bytes memory reportData) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(reportData)));
    }

    function signOne(bytes memory reportData, uint256 key) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest(reportData));
        return abi.encodePacked(r, s, v);
    }

    /// @notice Signs in the given key order, WITHOUT sorting. For negative tests only.
    function signUnsorted(bytes memory reportData, uint256[] memory keys)
        internal
        pure
        returns (bytes[] memory signatures)
    {
        signatures = new bytes[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            signatures[i] = signOne(reportData, keys[i]);
        }
    }

    /// @notice Signs with signatures ordered by strictly ascending signer address — what the
    ///         verifier requires and therefore what the publisher must do.
    function sign(bytes memory reportData, uint256[] memory keys)
        internal
        pure
        returns (bytes[] memory signatures)
    {
        return signUnsorted(reportData, sortKeysByAddress(keys));
    }

    /// @dev Insertion sort on a copy — key sets here are 5 elements, and a copy keeps callers
    ///      from being surprised by their own array being reordered underneath them.
    function sortKeysByAddress(uint256[] memory keys) internal pure returns (uint256[] memory out) {
        out = new uint256[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            out[i] = keys[i];
        }
        for (uint256 i = 1; i < out.length; i++) {
            uint256 key = out[i];
            address addr = vm.addr(key);
            uint256 j = i;
            while (j > 0 && vm.addr(out[j - 1]) > addr) {
                out[j] = out[j - 1];
                j--;
            }
            out[j] = key;
        }
    }

    function pack(bytes memory reportData, bytes[] memory signatures)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(reportData, signatures);
    }

    /// @notice The whole happy path in one call: encode, sign sorted, pack.
    function signedReport(Report memory r, uint256[] memory keys)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory reportData = encode(r);
        return pack(reportData, sign(reportData, keys));
    }

    function keys1(uint256 a) internal pure returns (uint256[] memory k) {
        k = new uint256[](1);
        k[0] = a;
    }

    function keys2(uint256 a, uint256 b) internal pure returns (uint256[] memory k) {
        k = new uint256[](2);
        k[0] = a;
        k[1] = b;
    }

    function keys3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory k) {
        k = new uint256[](3);
        k[0] = a;
        k[1] = b;
        k[2] = c;
    }
}
