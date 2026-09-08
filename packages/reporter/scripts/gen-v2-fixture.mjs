/**
 * Generates the cross-language fixture consumed by
 * `contracts/test/integration/PublisherVerifierWire.t.sol`.
 *
 * The publisher (JavaScript) and the verifier (Solidity) were written independently
 * against a written wire-format spec. Each is internally tested against its own idea of
 * that format, so a shared misreading would pass both suites and fail only on chain.
 * This fixture is the only artefact that crosses the language boundary: bytes produced
 * here are fed verbatim to `WhitespaceVerifier.verify`.
 *
 * Run:  node packages/reporter/scripts/gen-v2-fixture.mjs
 * (from the repo root; viem resolves out of packages/reporter/node_modules)
 *
 * The values below are pinned to match the Solidity test's constants. Changing either
 * side without regenerating breaks the test loudly, which is the intent.
 */
import { toHex } from 'viem';
import { buildReportDataV2, signAndEncodeReportV2 } from '../src/report-v2.mjs';

// Same keys the Solidity oracle tests use, so `vm.addr(K)` and `privateKeyToAccount`
// agree on the signer set without either side hardcoding addresses.
const KEYS = [0xa11ce01n, 0xa11ce02n, 0xa11ce03n].map((k) => toHex(k, { size: 32 }));

const FIELDS = {
  chainId: 1874n,
  verifier: '0x000000000000000000000000000000000000bEEF',
  feedId: toHex('BTC/USD', { size: 32 }), // bytes32("BTC/USD"), right-padded ASCII
  timestamp: 1_700_000_000,
  price: 65_000n * 10n ** 18n, // $65,000.00 at 18 decimals
  bid: 65_000n * 10n ** 18n - 10n ** 18n,
  ask: 65_000n * 10n ** 18n + 10n ** 18n,
  isMarketOpen: true,
  isDayTradingClosed: false,
};

const reportData = buildReportDataV2(FIELDS);
const { signedReport, signers } = await signAndEncodeReportV2(reportData, KEYS);

console.log('// signers, ascending as the verifier requires:');
for (const s of signers) console.log('//   ', s);
console.log('\nbytes constant REPORT_DATA = hex"%s";', reportData.slice(2));
console.log('\nbytes constant SIGNED_REPORT = hex"%s";', signedReport.slice(2));
