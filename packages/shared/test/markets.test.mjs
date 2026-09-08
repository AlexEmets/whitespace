import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asciiToBytes32Hex, MARKETS, getMarket } from '../src/markets.mjs';

test('asciiToBytes32Hex matches the proven-against-cast feed id fixture from packages/reporter', () => {
  // Same literal used in packages/reporter/test/report.test.mjs, produced there via
  // viem's stringToHex('BTC/USD', { size: 32 }).
  assert.equal(
    asciiToBytes32Hex('BTC/USD'),
    '0x4254432f55534400000000000000000000000000000000000000000000000000',
  );
});

test('asciiToBytes32Hex right-pads to exactly 32 bytes', () => {
  const hex = asciiToBytes32Hex('ETH/USD');
  assert.equal(hex.length, 66); // '0x' + 64 hex chars
  assert.match(hex, /^0x[0-9a-f]{64}$/);
});

test('asciiToBytes32Hex rejects input longer than 32 bytes', () => {
  assert.throws(() => asciiToBytes32Hex('a'.repeat(33)));
});

test('MARKETS defines BTC/USD and ETH/USD with a symbol for every venue', () => {
  for (const feed of ['BTC/USD', 'ETH/USD']) {
    const market = getMarket(feed);
    assert.equal(market.feed, feed);
    assert.match(market.feedId, /^0x[0-9a-f]{64}$/);
    for (const venue of ['binance', 'bybit', 'okx', 'whitebit']) {
      assert.equal(typeof market.venueSymbols[venue], 'string');
    }
  }
  assert.equal(Object.keys(MARKETS).length, 2);
});

test('getMarket throws on an unknown feed', () => {
  assert.throws(() => getMarket('DOGE/USD'));
});
