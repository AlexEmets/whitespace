import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asciiToBytes32Hex, MARKETS, MARKET_FEEDS, getMarket } from '../src/markets.mjs';
import { VENUE_IDS } from '../src/venues.mjs';

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

// Structural, not a pinned count: the registry is meant to grow, and a count assertion only
// ever fails on the commit that grows it. What must not drift is that EVERY listed market has
// a symbol for EVERY venue — services/price-publisher/src/main.mjs skips a missing one with a
// bare `continue`, so the market silently loses a venue, and below MIN_HEALTHY_VENUES the feed
// never signs a report at all. Iterating VENUE_IDS rather than a literal list keeps this honest
// if a fifth venue is ever added.
test('every market in MARKETS has a well-formed feed id and a symbol for every venue', () => {
  assert.ok(MARKET_FEEDS.length > 0);
  for (const feed of MARKET_FEEDS) {
    const market = getMarket(feed);
    assert.equal(market.feed, feed);
    assert.match(market.feedId, /^0x[0-9a-f]{64}$/);
    assert.equal(market.feedId, asciiToBytes32Hex(feed));
    for (const venue of VENUE_IDS) {
      assert.equal(typeof market.venueSymbols[venue], 'string', `${feed} is missing a ${venue} symbol`);
    }
  }
  assert.deepEqual(MARKET_FEEDS, Object.keys(MARKETS));
});

// The three markets listed on chain 1874. Named explicitly so that REMOVING one is a test
// failure rather than a silent capability loss — the structural test above cannot notice an
// absence.
test('MARKETS defines BTC/USD, ETH/USD and SOL/USD', () => {
  for (const feed of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
    assert.ok(MARKET_FEEDS.includes(feed), `${feed} is missing from MARKETS`);
  }
});

test('getMarket throws on an unknown feed', () => {
  assert.throws(() => getMarket('DOGE/USD'));
});
