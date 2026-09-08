import { encodeAbiParameters, hashMessage, keccak256, recoverAddress } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';

/**
 * v2 wire format — additive, alongside the v1 exports in ./report.mjs, which must not
 * be touched (its encoding is proven byte-for-byte against `cast`). v2 is the format
 * for the k-of-N hardened verifier (design spec §6.2): domain-separated by chainId and
 * verifier address, and carrying an array of signatures instead of exactly one.
 *
 *   reportData = abi.encode(
 *     uint256 chainId, address verifier, bytes32 feedId, uint32 timestamp,
 *     int192 price, int192 bid, int192 ask, bool isMarketOpen, bool isDayTradingClosed
 *   )
 *   signedReport = abi.encode(bytes reportData, bytes[] signatures)   // each sig 65 bytes, r||s||v
 *   digest = keccak256("\x19Ethereum Signed Message:\n32" || keccak256(reportData))
 *
 * The verifier requires signer addresses strictly ascending among the signatures it is
 * given, so signAndEncodeReportV2 sorts before encoding.
 */

const REPORT_FIELDS_V2 = [
  { type: 'uint256' }, // chainId
  { type: 'address' }, // verifier
  { type: 'bytes32' }, // feedId
  { type: 'uint32' }, // timestamp
  { type: 'int192' }, // price, 18 decimals
  { type: 'int192' }, // bid, 18 decimals
  { type: 'int192' }, // ask, 18 decimals
  { type: 'bool' }, // isMarketOpen
  { type: 'bool' }, // isDayTradingClosed
];

/**
 * @param {object} fields
 * @param {number|bigint} fields.chainId
 * @param {`0x${string}`} fields.verifier
 * @param {`0x${string}`} fields.feedId
 * @param {number} fields.timestamp
 * @param {bigint} fields.price
 * @param {bigint} fields.bid
 * @param {bigint} fields.ask
 * @param {boolean} fields.isMarketOpen
 * @param {boolean} fields.isDayTradingClosed
 * @returns {`0x${string}`}
 */
export function buildReportDataV2({
  chainId,
  verifier,
  feedId,
  timestamp,
  price,
  bid,
  ask,
  isMarketOpen,
  isDayTradingClosed,
}) {
  return encodeAbiParameters(REPORT_FIELDS_V2, [
    BigInt(chainId),
    verifier,
    feedId,
    timestamp,
    price,
    bid,
    ask,
    isMarketOpen,
    isDayTradingClosed,
  ]);
}

/**
 * Signs one report with one key, EIP-191 personal_sign over keccak256(reportData) —
 * the same scheme OstiumVerifier.verify recovers with. Returns a flat 65-byte
 * signature (r||s||v) and the address it will recover to, rather than the account's
 * own signMessage() string, so callers never have to re-slice it.
 *
 * @param {`0x${string}`} reportData
 * @param {`0x${string}`} privateKey
 * @returns {Promise<{ address: `0x${string}`, signature: `0x${string}` }>}
 */
export async function signReportV2(reportData, privateKey) {
  const account = privateKeyToAccount(privateKey);
  const digest = keccak256(reportData);
  const { r, s, v } = await sign({ hash: hashMessage({ raw: digest }), privateKey });
  const signature = `${r}${s.slice(2)}${v.toString(16).padStart(2, '0')}`;
  return { address: account.address, signature };
}

/**
 * Recovers the signer address from a v2 report + one 65-byte signature. Used to prove
 * signatures actually sort by *recovered* signer, not just by the address the caller
 * claims signed.
 * @param {`0x${string}`} reportData
 * @param {`0x${string}`} signature
 * @returns {Promise<`0x${string}`>}
 */
export async function recoverReportSignerV2(reportData, signature) {
  return recoverAddress({ hash: hashMessage({ raw: keccak256(reportData) }), signature });
}

/**
 * Sorts { address, signature } entries ascending by address, as bytes32-free 160-bit
 * integers — the verifier's strictly-ascending requirement.
 * @param {{ address: `0x${string}`, signature: `0x${string}` }[]} entries
 */
export function sortSignaturesByAddress(entries) {
  return [...entries].sort((a, b) => {
    const x = BigInt(a.address.toLowerCase());
    const y = BigInt(b.address.toLowerCase());
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  });
}

/**
 * @param {`0x${string}`} reportData
 * @param {`0x${string}`[]} sortedSignatures 65-byte signatures, already ascending by
 *   recovered signer
 * @returns {`0x${string}`}
 */
export function encodeSignedReportV2(reportData, sortedSignatures) {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [reportData, sortedSignatures]);
}

/**
 * Convenience end-to-end: sign reportData with every given key, sort the resulting
 * signatures ascending by recovered signer, and encode the k-of-N signedReport bytes.
 * This is what the publisher calls once it has decided to sign at all.
 *
 * @param {`0x${string}`} reportData
 * @param {`0x${string}`[]} privateKeys
 * @returns {Promise<{ signedReport: `0x${string}`, signers: `0x${string}`[] }>}
 */
export async function signAndEncodeReportV2(reportData, privateKeys) {
  const signed = await Promise.all(privateKeys.map((pk) => signReportV2(reportData, pk)));
  const sorted = sortSignaturesByAddress(signed);
  const signedReport = encodeSignedReportV2(
    reportData,
    sorted.map((s) => s.signature),
  );
  return { signedReport, signers: sorted.map((s) => s.address) };
}
