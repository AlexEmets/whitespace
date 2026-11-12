# @whitespace/reporter

Builds, signs and encodes the price reports that `WhitespaceVerifier` accepts on chain.
The publisher signs with it, the keeper wraps the result into `performUpkeep` calldata.
Its only dependency is `viem`.

```js
import { buildReportDataV2, signAndEncodeReportV2 } from '@whitespace/reporter/report-v2';
import { encodePerformData } from '@whitespace/reporter';

const reportData = buildReportDataV2({
  chainId: 1874, verifier, feedId,              // feedId: bytes32 of 'BTC/USD'
  timestamp, price, bid, ask,                   // bigint, 18 decimals
  isMarketOpen: true, isDayTradingClosed: false,
});
const { signedReport, signers } = await signAndEncodeReportV2(reportData, signerPrivateKeys);
const performData = encodePerformData(signedReport, orderId);
```

## v2 wire format (`@whitespace/reporter/report-v2`)

The format of the k-of-N verifier, domain-separated by chain id and verifier address:

```
reportData   = abi.encode(uint256 chainId, address verifier, bytes32 feedId, uint32 timestamp,
                          int192 price, int192 bid, int192 ask, bool isMarketOpen,
                          bool isDayTradingClosed)
signedReport = abi.encode(bytes reportData, bytes[] signatures)   // each 65 bytes, r||s||v
digest       = keccak256("\x19Ethereum Signed Message:\n32" || keccak256(reportData))
```

| Export | What it does |
|---|---|
| `buildReportDataV2(fields)` | ABI-encodes the nine-field tuple above. Prices are 18-decimal bigints. |
| `signReportV2(reportData, privateKey)` | EIP-191 signature over `keccak256(reportData)`. Returns `{ address, signature }`, the signature as a flat 65-byte hex string. |
| `recoverReportSignerV2(reportData, signature)` | Recovers the signer address of one signature. |
| `sortSignaturesByAddress(entries)` | Returns a copy of `{ address, signature }[]` sorted ascending by address. The verifier requires signers strictly ascending. |
| `encodeSignedReportV2(reportData, sortedSignatures)` | ABI-encodes `(bytes, bytes[])`. Expects the signatures already sorted. |
| `signAndEncodeReportV2(reportData, privateKeys)` | Signs with every key, sorts, encodes. Returns `{ signedReport, signers }`, with `signers` in the encoded order. |

## v1 exports (`@whitespace/reporter`)

The original single-signature format, kept unchanged:

| Export | What it does |
|---|---|
| `buildReportData(fields)` | ABI-encodes the seven-field tuple `(bytes32 feedId, uint32 timestamp, int192 price, int192 bid, int192 ask, bool, bool)`, without chain id or verifier. |
| `signReport(reportData, privateKey)` | Signs `keccak256(reportData)` with the EIP-191 prefix and encodes `(bytes reportData, bytes32 r, bytes32 s, uint8 v)`. |
| `encodePerformData(signedReport, orderId)` | ABI-encodes `(bytes signedReport, uint256 orderId)`, the `performUpkeep` argument. Used with v2 reports too. |

## Cross-language fixture

`scripts/gen-v2-fixture.mjs` prints the `REPORT_DATA` and `SIGNED_REPORT` byte constants
used by `contracts/test/integration/PublisherVerifierWire.t.sol`, from fixed test keys and
fields that match the Solidity test's constants. It is the one artefact that proves the
JavaScript encoder and the Solidity verifier agree on the format. Regenerate it whenever
either side changes:

```bash
node packages/reporter/scripts/gen-v2-fixture.mjs   # from the repo root
```

## Consumers

| Consumer | Uses |
|---|---|
| `services/price-publisher` | `buildReportDataV2`, `signAndEncodeReportV2` (signs every report it serves) |
| `services/keeper` | `buildReportDataV2`, `signAndEncodeReportV2` (report source), `encodePerformData` (calldata) |
| `tools/oracle-probe/verify-report.mjs` | Imports `src/report-v2.mjs` by relative path to check a report against a deployed verifier |

## Tests

```bash
pnpm --filter @whitespace/reporter test   # node --test
```

The suites decode every encoding back with viem, check signatures recover to the signing
keys and that signatures are ordered by recovered signer.
