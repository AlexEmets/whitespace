import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeAbiParameters, recoverAddress, hashMessage, keccak256 } from 'viem';
import { createPublisherEngine } from '../src/engine.mjs';
import { PUBLISHER_BOUNDS } from '@whitespace/shared/bounds';
import { getMarket } from '@whitespace/shared/markets';

const SCALE = 10n ** 18n;
const NOW = 1_757_325_600_000;
const VERIFIER = '0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8';
const CHAIN_ID = 1874;

function makeKeys(n) {
  return Array.from({ length: n }, () => {
    const pk = generatePrivateKey();
    return { address: privateKeyToAccount(pk).address, privateKey: pk };
  });
}

function tick(venue, bid, ask, ts = NOW) {
  return { venue, bid, ask, ts };
}

function newEngine({ signerKeys = makeKeys(5), signatureThresholdK = 3, markets = ['BTC/USD'] } = {}) {
  return createPublisherEngine({
    chainId: CHAIN_ID,
    verifierAddress: VERIFIER,
    markets,
    bounds: { ...PUBLISHER_BOUNDS, markEmaSampleIntervalMs: 1000 },
    signerKeys,
    signatureThresholdK,
    now: () => NOW,
  });
}

test('healthy 3-venue agreement produces a signed report with an exact 18-decimal price', async () => {
  const engine = newEngine();
  engine.ingestTick('BTC/USD', tick('binance', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('bybit', 65_000n * SCALE + 500_000_000_000_000_000n, 65_001n * SCALE + 500_000_000_000_000_000n));
  engine.ingestTick('BTC/USD', tick('okx', 64_999n * SCALE + 500_000_000_000_000_000n, 65_000n * SCALE + 500_000_000_000_000_000n));
  engine.sampleMark('BTC/USD');

  const result = await engine.signReportFor('BTC/USD', 1_757_325_600, 'MARKET_OPEN');
  assert.equal(result.ok, true);
  assert.equal(typeof result.signedReport, 'string');
  // First sample seeds the EMA directly, so mark == index on this first tick.
  assert.equal(result.mark, 65_000n * SCALE + 500_000_000_000_000_000n);

  const [reportData, signatures] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], result.signedReport);
  const decoded = decodeAbiParameters(
    [
      { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint32' },
      { type: 'int192' }, { type: 'int192' }, { type: 'int192' }, { type: 'bool' }, { type: 'bool' },
    ],
    reportData,
  );
  assert.equal(decoded[0], BigInt(CHAIN_ID));
  assert.equal(decoded[1], VERIFIER);
  assert.equal(decoded[2], getMarket('BTC/USD').feedId);
  assert.equal(decoded[3], 1_757_325_600);
  assert.equal(decoded[4], result.mark); // price == mark, exact 18-decimal bigint
  assert.equal(signatures.length, 5);
});

test('signatures in the signed report are sorted ascending by RECOVERED signer', async () => {
  const engine = newEngine();
  engine.ingestTick('BTC/USD', tick('binance', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('bybit', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('okx', 65_000n * SCALE, 65_001n * SCALE));
  engine.sampleMark('BTC/USD');
  const result = await engine.signReportFor('BTC/USD', 1_757_325_600, 'MARKET_CLOSE');
  assert.equal(result.ok, true);

  const [reportData, signatures] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], result.signedReport);
  const recovered = await Promise.all(
    signatures.map((sig) => recoverAddress({ hash: hashMessage({ raw: keccak256(reportData) }), signature: sig })),
  );
  assert.deepEqual(recovered, result.signers);
  for (let i = 1; i < recovered.length; i++) {
    assert.ok(BigInt(recovered[i - 1].toLowerCase()) < BigInt(recovered[i].toLowerCase()));
  }
});

test('a disagreeing venue set produces NO signed report, not a signed bad one', async () => {
  const engine = newEngine();
  // Only 2 of these are mutually consistent; a wild third value is a symmetric
  // disagreement with no majority, so the deviation filter rejects venues down to a
  // point where minHealthyVenues cannot be met for opens.
  engine.ingestTick('BTC/USD', tick('binance', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('bybit', 70_000n * SCALE, 70_001n * SCALE)); // ~7.7% away
  engine.sampleMark('BTC/USD');

  const result = await engine.signReportFor('BTC/USD', 1_757_325_600, 'MARKET_OPEN');
  assert.equal(result.ok, false);
  assert.equal('signedReport' in result, false);
});

test('degraded mode: opens are refused, closes still get a signed report', async () => {
  const engine = newEngine();
  // Only 2 healthy venues -> degraded (min is 3).
  engine.ingestTick('BTC/USD', tick('binance', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('bybit', 65_000n * SCALE, 65_001n * SCALE));
  engine.sampleMark('BTC/USD');

  const openResult = await engine.signReportFor('BTC/USD', 1_757_325_600, 'MARKET_OPEN');
  assert.equal(openResult.ok, false);
  assert.equal(openResult.reason, 'degraded_opens_blocked');

  const closeResult = await engine.signReportFor('BTC/USD', 1_757_325_600, 'MARKET_CLOSE');
  assert.equal(closeResult.ok, true);
  assert.equal('signedReport' in closeResult, true);
});

test('zero venues: nothing to sign for any order type, including closes', async () => {
  const engine = newEngine();
  const result = await engine.signReportFor('BTC/USD', 1_757_325_600, 'MARKET_CLOSE');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_healthy_venues');
});

test('healthy ticks but the EMA was never sampled: refuses with no_mark_yet, not a stale price', async () => {
  const engine = newEngine();
  engine.ingestTick('BTC/USD', tick('binance', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('bybit', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('okx', 65_000n * SCALE, 65_001n * SCALE));
  // Deliberately no engine.sampleMark('BTC/USD') call.
  const result = await engine.signReportFor('BTC/USD', 1_757_325_600, 'MARKET_CLOSE');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_mark_yet');
});

test('fewer than k signer keys refuses to sign, even with a healthy aggregate', async () => {
  const engine = newEngine({ signerKeys: makeKeys(2), signatureThresholdK: 3 });
  engine.ingestTick('BTC/USD', tick('binance', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('bybit', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('okx', 65_000n * SCALE, 65_001n * SCALE));
  engine.sampleMark('BTC/USD');
  const result = await engine.signReportFor('BTC/USD', 1_757_325_600, 'MARKET_OPEN');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insufficient_signer_keys');
});

test('the timestamp in the signed report is exactly the caller-supplied value, not the sampling time', async () => {
  const engine = newEngine();
  engine.ingestTick('BTC/USD', tick('binance', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('bybit', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('okx', 65_000n * SCALE, 65_001n * SCALE));
  engine.sampleMark('BTC/USD');

  const oldOrderTimestamp = 1_700_000_000; // long before "now"
  const result = await engine.signReportFor('BTC/USD', oldOrderTimestamp, 'MARKET_CLOSE');
  assert.equal(result.ok, true);
  const [reportData] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], result.signedReport);
  const decoded = decodeAbiParameters(
    [
      { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint32' },
      { type: 'int192' }, { type: 'int192' }, { type: 'int192' }, { type: 'bool' }, { type: 'bool' },
    ],
    reportData,
  );
  assert.equal(decoded[3], oldOrderTimestamp);
});
