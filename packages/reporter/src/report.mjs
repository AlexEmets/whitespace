import { encodeAbiParameters, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The tuple OstiumPrivatePriceUpKeep.performUpkeep decodes out of the verifier response.
 * Prices carry 18 decimals; a wrong exponent does not revert anywhere.
 */
const REPORT_FIELDS = [
  { type: 'bytes32' }, { type: 'uint32' }, { type: 'int192' },
  { type: 'int192' }, { type: 'int192' }, { type: 'bool' }, { type: 'bool' },
];

export function buildReportData({ feedId, timestamp, price, bid, ask, isMarketOpen, isDayTradingClosed }) {
  return encodeAbiParameters(REPORT_FIELDS, [
    feedId, timestamp, price, bid, ask, isMarketOpen, isDayTradingClosed,
  ]);
}

/**
 * OstiumVerifier.verify recovers with the EIP-191 personal_sign prefix over keccak256(reportData),
 * so we sign the raw hash as a message rather than signing it directly.
 */
export async function signReport(reportData, privateKey) {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signMessage({ message: { raw: keccak256(reportData) } });
  const r = `0x${signature.slice(2, 66)}`;
  const s = `0x${signature.slice(66, 130)}`;
  const v = parseInt(signature.slice(130, 132), 16);
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }],
    [reportData, r, s, v],
  );
}

export function encodePerformData(signedReport, orderId) {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'uint256' }], [signedReport, orderId]);
}
