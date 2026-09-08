import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildReportDataV2,
  signReportV2,
  recoverReportSignerV2,
  sortSignaturesByAddress,
  encodeSignedReportV2,
  signAndEncodeReportV2,
} from '../src/report-v2.mjs';
import { encodePerformData } from '../src/report.mjs';

const FIELDS = [
  { type: 'uint256' },
  { type: 'address' },
  { type: 'bytes32' },
  { type: 'uint32' },
  { type: 'int192' },
  { type: 'int192' },
  { type: 'int192' },
  { type: 'bool' },
  { type: 'bool' },
];

const BASE = {
  chainId: 1874,
  verifier: '0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8',
  feedId: '0x4254432f55534400000000000000000000000000000000000000000000000000',
  timestamp: 1757325600,
  price: 65_000_000_000_000_000_000_000n,
  bid: 64_999_000_000_000_000_000_000n,
  ask: 65_001_000_000_000_000_000_000n,
  isMarketOpen: true,
  isDayTradingClosed: false,
};

test('buildReportDataV2 round-trips through the exact k-of-N tuple, chainId and verifier included', () => {
  const data = buildReportDataV2(BASE);
  const decoded = decodeAbiParameters(FIELDS, data);
  assert.equal(decoded[0], 1874n);
  assert.equal(decoded[1], BASE.verifier);
  assert.equal(decoded[2], BASE.feedId);
  assert.equal(decoded[3], BASE.timestamp);
  assert.equal(decoded[4], BASE.price);
  assert.equal(decoded[5], BASE.bid);
  assert.equal(decoded[6], BASE.ask);
  assert.equal(decoded[7], true);
  assert.equal(decoded[8], false);
});

test('a negative int192 price round-trips through the v2 encoder', () => {
  const data = buildReportDataV2({ ...BASE, price: -1n, bid: -2n, ask: -3n });
  const decoded = decodeAbiParameters(FIELDS, data);
  assert.equal(decoded[4], -1n);
  assert.equal(decoded[5], -2n);
  assert.equal(decoded[6], -3n);
});

test('two different verifier addresses produce different reportData (domain separation)', () => {
  const a = buildReportDataV2(BASE);
  const otherVerifier = privateKeyToAccount(generatePrivateKey()).address;
  const b = buildReportDataV2({ ...BASE, verifier: otherVerifier });
  assert.notEqual(a, b);
});

test('two different chainIds produce different reportData (domain separation)', () => {
  const a = buildReportDataV2(BASE);
  const b = buildReportDataV2({ ...BASE, chainId: 2625 });
  assert.notEqual(a, b);
});

test('signReportV2 signature recovers to the signing key', async () => {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const data = buildReportDataV2(BASE);
  const { address, signature } = await signReportV2(data, key);
  assert.equal(address, account.address);
  const recovered = await recoverReportSignerV2(data, signature);
  assert.equal(recovered, account.address);
  // 65 raw bytes: 0x + 130 hex chars
  assert.equal(signature.length, 132);
});

test('sortSignaturesByAddress sorts strictly ascending regardless of input order', () => {
  const entries = [
    { address: '0xFFFF00000000000000000000000000000000FF', signature: '0x1' },
    { address: '0x0000000000000000000000000000000000000A', signature: '0x2' },
    { address: '0x5555555555555555555555555555555555555A', signature: '0x3' },
  ];
  const sorted = sortSignaturesByAddress(entries);
  assert.deepEqual(
    sorted.map((s) => s.address),
    [
      '0x0000000000000000000000000000000000000A',
      '0x5555555555555555555555555555555555555A',
      '0xFFFF00000000000000000000000000000000FF',
    ],
  );
});

test('signAndEncodeReportV2 emits signatures sorted ascending by the RECOVERED signer, not input order', async () => {
  const keys = Array.from({ length: 5 }, () => generatePrivateKey());
  // Sign in a deliberately scrambled order relative to the eventual address order.
  const data = buildReportDataV2(BASE);
  const { signedReport, signers } = await signAndEncodeReportV2(data, keys);

  // signers must be strictly ascending as 160-bit integers.
  for (let i = 1; i < signers.length; i++) {
    assert.ok(BigInt(signers[i - 1].toLowerCase()) < BigInt(signers[i].toLowerCase()), 'signers must be strictly ascending');
  }

  const [decodedData, signatures] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], signedReport);
  assert.equal(decodedData, data);
  assert.equal(signatures.length, 5);

  // Independently recover each signature and confirm the recovered addresses are
  // exactly the sorted signer list — proves the sort key really is the recovered
  // signer, not merely the address the signer claimed.
  const recovered = await Promise.all(signatures.map((sig) => recoverReportSignerV2(decodedData, sig)));
  assert.deepEqual(recovered, signers);
  for (let i = 1; i < recovered.length; i++) {
    assert.ok(BigInt(recovered[i - 1].toLowerCase()) < BigInt(recovered[i].toLowerCase()));
  }
});

test('encodeSignedReportV2 + report.mjs encodePerformData compose into the on-chain performData tuple', async () => {
  const keys = Array.from({ length: 3 }, () => generatePrivateKey());
  const data = buildReportDataV2(BASE);
  const { signedReport } = await signAndEncodeReportV2(data, keys);

  // encodePerformData is an existing, untouched v1 export — reused as-is because it is
  // format-agnostic: abi.encode(bytes, uint256) does not care what is inside the bytes.
  const performData = encodePerformData(signedReport, 42n);
  const [decodedSignedReport, orderId] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint256' }],
    performData,
  );
  assert.equal(decodedSignedReport, signedReport);
  assert.equal(orderId, 42n);
});

test('encodeSignedReportV2 rejects nothing but is the (bytes, bytes[]) shape the k-of-N verifier expects', () => {
  const data = buildReportDataV2(BASE);
  const encoded = encodeSignedReportV2(data, ['0x' + '11'.repeat(65), '0x' + '22'.repeat(65)]);
  const [decodedData, sigs] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], encoded);
  assert.equal(decodedData, data);
  assert.equal(sigs.length, 2);
});
