/**
 * Per-market bounds, end to end through the publisher: the aggregate reports which
 * threshold it applied, the engine judges each feed by its own, and the do-not-sign gate
 * follows from that rather than from a global constant.
 *
 * These live in one file rather than spread across aggregator/engine/server tests because
 * the property being protected is the seam between them — the failure mode is not "one
 * layer is wrong" but "two layers disagree about what degraded means for this market".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { computeIndex, canSignForOrderType } from '../src/aggregator.mjs';
import { createPublisherEngine } from '../src/engine.mjs';
import { createServerApp } from '../src/server.mjs';
import { PUBLISHER_BOUNDS, boundsForMarket } from '@whitespace/shared/bounds';

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

/** Two agreeing quotes, tight enough to clear the spread and deviation filters. */
function twoWhitebitBooks() {
  return [
    tick('whitebit', 86n * SCALE, 86n * SCALE + 10_000_000_000_000_000n),
    tick('whitebit_perp', 86n * SCALE, 86n * SCALE + 20_000_000_000_000_000n),
  ];
}

test('computeIndex reports the threshold it applied, not just the verdict', () => {
  const ticks = twoWhitebitBooks();

  const strict = computeIndex(ticks, NOW, PUBLISHER_BOUNDS, () => 1n);
  assert.equal(strict.healthyCount, 2);
  assert.equal(strict.minHealthyVenues, 3);
  assert.equal(strict.degraded, true);

  const relaxed = computeIndex(ticks, NOW, boundsForMarket('WBT/USD'), () => 1n);
  assert.equal(relaxed.healthyCount, 2);
  assert.equal(relaxed.minHealthyVenues, 2);
  assert.equal(relaxed.degraded, false);

  // Same inputs, opposite verdicts, and the only thing that distinguishes them is carried
  // on the result. A consumer reading `degraded` alone cannot tell these apart.
  assert.equal(strict.index, relaxed.index);
});

test('the engine judges each feed by its own bounds within one process', () => {
  const engine = createPublisherEngine({
    chainId: CHAIN_ID,
    verifierAddress: VERIFIER,
    markets: ['BTC/USD', 'WBT/USD'],
    bounds: PUBLISHER_BOUNDS,
    boundsFor: boundsForMarket,
    signerKeys: makeKeys(5),
    signatureThresholdK: 3,
    now: () => NOW,
  });

  for (const t of twoWhitebitBooks()) engine.ingestTick('WBT/USD', t);
  engine.ingestTick('BTC/USD', tick('binance', 65_000n * SCALE, 65_001n * SCALE));
  engine.ingestTick('BTC/USD', tick('bybit', 65_000n * SCALE, 65_001n * SCALE));

  const wbt = engine.currentAggregate('WBT/USD');
  const btc = engine.currentAggregate('BTC/USD');

  assert.equal(wbt.healthyCount, 2);
  assert.equal(wbt.minHealthyVenues, 2);
  assert.equal(wbt.degraded, false);

  // Identical healthy count, stricter market: still degraded. This is the assertion that
  // fails if per-feed bounds ever collapse back to one engine-wide object.
  assert.equal(btc.healthyCount, 2);
  assert.equal(btc.minHealthyVenues, 3);
  assert.equal(btc.degraded, true);
});

test('the do-not-sign gate follows the per-market verdict for opens', () => {
  const ticks = twoWhitebitBooks();
  const wbt = computeIndex(ticks, NOW, boundsForMarket('WBT/USD'), () => 1n);
  const btc = computeIndex(ticks, NOW, PUBLISHER_BOUNDS, () => 1n);

  assert.deepEqual(canSignForOrderType('MARKET_OPEN', wbt), { ok: true });
  assert.equal(canSignForOrderType('MARKET_OPEN', btc).ok, false);
  assert.equal(canSignForOrderType('MARKET_OPEN', btc).reason, 'degraded_opens_blocked');

  // Closes are unaffected by degradation on either market — the asymmetry is the point.
  assert.deepEqual(canSignForOrderType('MARKET_CLOSE', btc), { ok: true });
});

test('one healthy source is still degraded for WBT — the override is 2, not "any"', () => {
  const [spot] = twoWhitebitBooks();
  const result = computeIndex([spot], NOW, boundsForMarket('WBT/USD'), () => 1n);
  assert.equal(result.healthyCount, 1);
  assert.equal(result.degraded, true);
  assert.equal(canSignForOrderType('MARKET_OPEN', result).ok, false);
});

// The two books police each other: that is the entire reason the threshold is 2 and not 1.
// A book that runs away past the deviation bound must take both down rather than become the
// index on its own.
test('a book diverging past the deviation bound leaves no signable price at all', () => {
  const ticks = [
    tick('whitebit', 86n * SCALE, 86n * SCALE + 10_000_000_000_000_000n),
    tick('whitebit_perp', 90n * SCALE, 90n * SCALE + 10_000_000_000_000_000n), // ~450 bps away
  ];
  const result = computeIndex(ticks, NOW, boundsForMarket('WBT/USD'), () => 1n);

  assert.equal(result.healthyCount, 0);
  assert.equal(result.noData, true);
  assert.equal(result.index, null);
  assert.equal(canSignForOrderType('MARKET_CLOSE', result).ok, false, 'nothing is signable without data');
});

test('GET /status publishes the per-feed threshold beside the verdict', async () => {
  const engine = createPublisherEngine({
    chainId: CHAIN_ID,
    verifierAddress: VERIFIER,
    markets: ['BTC/USD', 'WBT/USD'],
    bounds: PUBLISHER_BOUNDS,
    boundsFor: boundsForMarket,
    signerKeys: makeKeys(5),
    signatureThresholdK: 3,
    now: () => NOW,
  });
  for (const t of twoWhitebitBooks()) engine.ingestTick('WBT/USD', t);

  const server = createServerApp(engine);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(body.feeds['WBT/USD'].minHealthyVenues, 2);
    assert.equal(body.feeds['WBT/USD'].degraded, false);
    assert.equal(body.feeds['BTC/USD'].minHealthyVenues, 3);

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.feeds['WBT/USD'].minHealthyVenues, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
