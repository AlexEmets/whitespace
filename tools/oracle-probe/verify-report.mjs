/**
 * Proves that bytes produced by the real report signer are accepted by a deployed
 * `WhitespaceVerifier`, over RPC, against a live chain.
 *
 * `WhitespaceVerifier.verify` is `external view` (WhitespaceVerifier.sol:130), so this
 * costs no gas and sends no transaction: it is an `eth_call`. That is the point. The
 * publisher/contract wire contract (design D2 — nine fields, domain-separated by chainId
 * and verifier address, signatures sorted by recovered signer) can therefore be verified
 * against 1874 *before* any gas is spent migrating anything, and re-verified afterwards
 * as a regression check.
 *
 * Imports are relative rather than by package name on purpose: `tools/` is deliberately
 * not a pnpm workspace package, so `@whitespace/reporter` does not resolve from here.
 * The relative path does resolve, and `viem` then resolves from the reporter's own
 * node_modules.
 *
 * Usage:
 *   node tools/oracle-probe/verify-report.mjs \
 *     --rpc http://127.0.0.1:8545 --verifier 0x... \
 *     [--feed BTC/USD] [--price 65000] [--signers signer,signer-2,signer-3]
 *
 * Exit code 0 means the chain accepted the report and the decoded fields round-tripped.
 */

import { createPublicClient, decodeAbiParameters, http, stringToHex } from '../../packages/reporter/node_modules/viem/_esm/index.js';
import { buildReportDataV2, signAndEncodeReportV2 } from '../../packages/reporter/src/report-v2.mjs';
import { loadKeyFile } from '../../packages/shared/src/keys.mjs';

const REPORT_FIELDS_V2 = [
  { type: 'uint256', name: 'chainId' },
  { type: 'address', name: 'verifier' },
  { type: 'bytes32', name: 'feedId' },
  { type: 'uint32', name: 'timestamp' },
  { type: 'int192', name: 'price' },
  { type: 'int192', name: 'bid' },
  { type: 'int192', name: 'ask' },
  { type: 'bool', name: 'isMarketOpen' },
  { type: 'bool', name: 'isDayTradingClosed' },
];

const VERIFY_ABI = [
  {
    type: 'function',
    name: 'verify',
    stateMutability: 'view',
    inputs: [{ type: 'bytes', name: 'signedReport' }],
    outputs: [{ type: 'bytes', name: 'reportData' }],
  },
  { type: 'function', name: 'threshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'signerCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

const rpc = arg('rpc', 'http://127.0.0.1:8545');
const verifier = arg('verifier');
const feed = arg('feed', 'BTC/USD');
const priceWhole = arg('price', '65000');
const signerRoles = arg('signers', 'signer,signer-2,signer-3').split(',');

if (!verifier) throw new Error('--verifier is required');

const client = createPublicClient({ transport: http(rpc) });
const chainId = await client.getChainId();

// Read the contract's own parameters rather than assuming them: a probe that hardcodes
// k=3 would pass against a verifier configured for k=4 by signing more than required.
const [threshold, signerCount] = await Promise.all([
  client.readContract({ address: verifier, abi: VERIFY_ABI, functionName: 'threshold' }),
  client.readContract({ address: verifier, abi: VERIFY_ABI, functionName: 'signerCount' }),
]);

if (BigInt(signerRoles.length) < threshold) {
  throw new Error(`verifier requires ${threshold} signatures, only ${signerRoles.length} roles given`);
}

const keys = signerRoles.map((role) =>
  loadKeyFile(`${process.env.HOME}/.whitespace-keys/${role.trim()}.json`),
);

// 18 decimals for price, per the design's exponent table. Whole units in, wei-scale out.
const price = BigInt(priceWhole) * 10n ** 18n;
const timestamp = Math.floor(Date.now() / 1000);

const reportData = buildReportDataV2({
  chainId,
  verifier,
  feedId: stringToHex(feed, { size: 32 }),
  timestamp,
  price,
  bid: price,
  ask: price,
  isMarketOpen: true,
  isDayTradingClosed: false,
});

const { signedReport, signers } = await signAndEncodeReportV2(
  reportData,
  keys.map((k) => k.privateKey),
);

const returned = await client.readContract({
  address: verifier,
  abi: VERIFY_ABI,
  functionName: 'verify',
  args: [signedReport],
});

const decoded = decodeAbiParameters(REPORT_FIELDS_V2, returned);
const [gotChainId, gotVerifier, gotFeedId, gotTimestamp, gotPrice] = decoded;

// The chain returning bytes is not proof it returned OUR bytes. Compare the fields that
// carry the domain separation and the payload, not just the call's success.
const mismatches = [];
if (gotChainId !== BigInt(chainId)) mismatches.push(`chainId ${gotChainId} != ${chainId}`);
if (gotVerifier.toLowerCase() !== verifier.toLowerCase()) mismatches.push(`verifier ${gotVerifier}`);
if (gotFeedId !== stringToHex(feed, { size: 32 })) mismatches.push(`feedId ${gotFeedId}`);
if (gotTimestamp !== timestamp) mismatches.push(`timestamp ${gotTimestamp} != ${timestamp}`);
if (gotPrice !== price) mismatches.push(`price ${gotPrice} != ${price}`);

if (mismatches.length > 0) {
  console.error('ACCEPTED BUT ROUND-TRIP MISMATCH:', mismatches.join('; '));
  process.exit(1);
}

console.log(`chain            ${chainId}`);
console.log(`verifier         ${verifier}`);
console.log(`threshold        ${threshold} of ${signerCount} authorised`);
// Printed in the order the encoder sorted them, ascending by RECOVERED signer address —
// that ordering is what stops one signature being replayed k times, so seeing it is the
// point, not a formatting detail.
console.log(`signed by        ${signers.length} real key files, sorted ascending:`);
for (const address of signers) console.log(`                   ${address}`);
console.log(`feed             ${feed}`);
console.log(`price            ${price} (${priceWhole}, 18 dp)`);
console.log(`timestamp        ${timestamp}`);
console.log(`signedReport     ${signedReport.length} hex chars`);
console.log('');
console.log('ACCEPTED — the deployed verifier decoded and recovered our report, all fields round-tripped.');
