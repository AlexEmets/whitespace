import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asciiToBytes32Hex, MARKETS, MARKET_FEEDS, getMarket } from '../src/markets.mjs';
import { VENUE_IDS } from '../src/venues.mjs';
import { boundsForMarket } from '../src/bounds.mjs';

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
// ever fails on the commit that grows it.
//
// This used to require EVERY market to name EVERY venue. That stopped being the invariant
// when venues became per-market: WBT/USD is quoted inside the spread bound on WhiteBIT's two
// books alone, so demanding a binance symbol for it would assert something false. The rule it
// was really protecting is the one asserted here instead — services/price-publisher/src/main.mjs
// skips a venue a market has no symbol for with a bare `continue`, so a market that declares
// fewer sources than its own minHealthyVenues can never reach a healthy count and silently
// never signs an opening report. Checking against boundsForMarket ties the assertion to the
// threshold that actually gates signing, per market, rather than to a venue count.
//
// The venue-id direction is checked too, which the old form could not: a typo'd key like
// `whitebit_per` would previously just sit there unused, costing the market a source at runtime
// with nothing to notice it.
test('every market has a well-formed feed id and enough known-venue symbols to sign', () => {
  assert.ok(MARKET_FEEDS.length > 0);
  for (const feed of MARKET_FEEDS) {
    const market = getMarket(feed);
    assert.equal(market.feed, feed);
    assert.match(market.feedId, /^0x[0-9a-f]{64}$/);
    assert.equal(market.feedId, asciiToBytes32Hex(feed));

    const declared = Object.keys(market.venueSymbols);
    for (const venue of declared) {
      assert.ok(VENUE_IDS.includes(venue), `${feed} names unknown venue "${venue}"`);
      assert.equal(typeof market.venueSymbols[venue], 'string', `${feed}'s ${venue} symbol is not a string`);
    }

    const required = boundsForMarket(feed).minHealthyVenues;
    assert.ok(
      declared.length >= required,
      `${feed} declares ${declared.length} venue symbol(s) but needs ${required} healthy to sign opens`,
    );
  }
  assert.deepEqual(MARKET_FEEDS, Object.keys(MARKETS));
});

// Named explicitly so that REMOVING one is a test failure rather than a silent capability
// loss — the structural test above cannot notice an absence.
test('MARKETS defines BTC/USD, ETH/USD, SOL/USD and WBT/USD', () => {
  for (const feed of ['BTC/USD', 'ETH/USD', 'SOL/USD', 'WBT/USD']) {
    assert.ok(MARKET_FEEDS.includes(feed), `${feed} is missing from MARKETS`);
  }
});

// WBT is the one market allowed to run on a single exchange, so the shape that makes that
// tolerable is pinned: two distinct books, both on WhiteBIT, matching its lowered threshold.
// If someone later drops one of them, the market does not quietly become a single-source feed
// with no deviation cross-check — this fails first.
test('WBT/USD is fed by both WhiteBIT books, meeting its lowered threshold exactly', () => {
  const market = getMarket('WBT/USD');
  assert.deepEqual(Object.keys(market.venueSymbols).sort(), ['whitebit', 'whitebit_perp']);
  assert.equal(market.venueSymbols.whitebit, 'WBT_USDT');
  assert.equal(market.venueSymbols.whitebit_perp, 'WBT_PERP');
  assert.equal(boundsForMarket('WBT/USD').minHealthyVenues, 2);
});

test('getMarket throws on an unknown feed', () => {
  assert.throws(() => getMarket('DOGE/USD'));
});
