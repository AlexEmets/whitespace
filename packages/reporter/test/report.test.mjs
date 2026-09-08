import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, hashMessage, keccak256, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildReportData, signReport, encodePerformData } from '../src/report.mjs';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FEED = '0x4254432f55534400000000000000000000000000000000000000000000000000';
const FIELDS = {
  feedId: FEED,
  timestamp: 1757325600,
  price: 65000000000000000000000n,
  bid: 64999000000000000000000n,
  ask: 65001000000000000000000n,
  isMarketOpen: true,
  isDayTradingClosed: false,
};

test('report data round-trips through the exact on-chain tuple', () => {
  const data = buildReportData(FIELDS);
  const decoded = decodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint32' }, { type: 'int192' },
      { type: 'int192' }, { type: 'int192' }, { type: 'bool' }, { type: 'bool' },
    ],
    data,
  );
  assert.equal(decoded[0], FEED);
  assert.equal(decoded[1], 1757325600);
  assert.equal(decoded[2], 65000000000000000000000n);
  assert.equal(decoded[5], true);
  assert.equal(decoded[6], false);
});

test('price uses 18 decimals, so $65,000 is 65000e18', () => {
  assert.equal(FIELDS.price, 65000n * 10n ** 18n);
});

test('the signature recovers to the signing key', async () => {
  const data = buildReportData(FIELDS);
  const signed = await signReport(data, KEY);
  const [reportData, r, s, v] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }],
    signed,
  );
  assert.equal(reportData, data);
  const signature = `${r}${s.slice(2)}${v.toString(16).padStart(2, '0')}`;
  const recovered = await recoverAddress({ hash: hashMessage({ raw: keccak256(data) }), signature });
  assert.equal(recovered, privateKeyToAccount(KEY).address);
});

test('performData is the tuple performUpkeep decodes', () => {
  const performData = encodePerformData('0xdeadbeef', 42n);
  const [report, orderId] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint256' }],
    performData,
  );
  assert.equal(report, '0xdeadbeef');
  assert.equal(orderId, 42n);
});
