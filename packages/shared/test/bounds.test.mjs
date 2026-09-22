import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLISHER_BOUNDS,
  MARKET_BOUNDS_OVERRIDES,
  boundsForMarket,
  MIN_HEALTHY_VENUES,
} from '../src/bounds.mjs';

test('boundsForMarket returns the global bounds for a market with no override', () => {
  assert.deepEqual(boundsForMarket('BTC/USD'), PUBLISHER_BOUNDS);
  assert.deepEqual(boundsForMarket('ETH/USD'), PUBLISHER_BOUNDS);
  assert.deepEqual(boundsForMarket('SOL/USD'), PUBLISHER_BOUNDS);
});

// An unknown feed must not throw: callers resolve bounds before they have validated the
// feed name, and a throw here would turn a typo into a publisher crash rather than an
// "unknown feed" error from the layer that owns that check.
test('boundsForMarket falls back to the global bounds for an unknown feed', () => {
  assert.deepEqual(boundsForMarket('DOGE/USD'), PUBLISHER_BOUNDS);
});

test('boundsForMarket merges an override over the global bounds, keeping the rest', () => {
  const wbt = boundsForMarket('WBT/USD');
  assert.equal(wbt.minHealthyVenues, 2);
  assert.equal(wbt.stalenessBoundMs, 8_000);
  assert.notEqual(wbt.minHealthyVenues, PUBLISHER_BOUNDS.minHealthyVenues);
  assert.notEqual(wbt.stalenessBoundMs, PUBLISHER_BOUNDS.stalenessBoundMs);
  // Everything NOT named in the override must still be the tuned global value — the point
  // of a narrow override is that it does not quietly relax the other filters too. The
  // spread and deviation filters in particular are what still make a two-book market safe.
  assert.equal(wbt.spreadWidthBoundBps, PUBLISHER_BOUNDS.spreadWidthBoundBps);
  assert.equal(wbt.deviationBoundBps, PUBLISHER_BOUNDS.deviationBoundBps);
  assert.equal(wbt.markEmaWindowMs, PUBLISHER_BOUNDS.markEmaWindowMs);
  assert.equal(wbt.markEmaSampleIntervalMs, PUBLISHER_BOUNDS.markEmaSampleIntervalMs);
});

// A staleness bound only protects against a dead feed if it fires before the socket layer
// gives up on that socket; past that point the connection is being torn down and rebuilt
// anyway. IDLE_TIMEOUT_MS in services/price-publisher/src/venues/index.mjs is 20 s, so any
// override must stay comfortably under it or it stops being a check at all.
test('no staleness override outlives the WS idle watchdog that would reconnect the socket', () => {
  const WS_IDLE_TIMEOUT_MS = 20_000;
  for (const [feed, override] of Object.entries(MARKET_BOUNDS_OVERRIDES)) {
    if (override.stalenessBoundMs === undefined) continue;
    assert.ok(
      override.stalenessBoundMs < WS_IDLE_TIMEOUT_MS,
      `${feed} tolerates ${override.stalenessBoundMs}ms of silence, at or past the ${WS_IDLE_TIMEOUT_MS}ms idle watchdog`,
    );
    assert.ok(
      override.stalenessBoundMs >= PUBLISHER_BOUNDS.stalenessBoundMs,
      `${feed} tightens staleness below the global bound; that is not what this mechanism is for`,
    );
  }
});

// PUBLISHER_BOUNDS is a module-level singleton shared by every market. If boundsForMarket
// ever merged in place instead of spreading, one market's override would silently become
// every market's — the exact global loosening the override mechanism exists to prevent.
test('boundsForMarket never mutates the global bounds object', () => {
  const before = { ...PUBLISHER_BOUNDS };
  boundsForMarket('WBT/USD');
  assert.deepEqual(PUBLISHER_BOUNDS, before);
  assert.equal(PUBLISHER_BOUNDS.minHealthyVenues, MIN_HEALTHY_VENUES);
  assert.notEqual(boundsForMarket('WBT/USD'), PUBLISHER_BOUNDS);
});

// A misspelled key (minHealthyVenue, minHealthyVenuesCount, ...) merges cleanly and does
// exactly nothing: the market keeps the global threshold while the file claims otherwise.
// Nothing at runtime would report that, so it is asserted here.
test('every override names a real bounds key', () => {
  const valid = new Set(Object.keys(PUBLISHER_BOUNDS));
  for (const [feed, override] of Object.entries(MARKET_BOUNDS_OVERRIDES)) {
    for (const key of Object.keys(override)) {
      assert.ok(valid.has(key), `${feed} overrides unknown bound "${key}"`);
      assert.equal(
        typeof override[key],
        typeof PUBLISHER_BOUNDS[key],
        `${feed}'s "${key}" override has a different type than the global bound`,
      );
    }
  }
});

// A threshold of 1 disables the aggregator's leave-one-out deviation check entirely (with a
// single healthy source the comparison pool is empty and the tick is accepted unchecked), so
// no market may be configured down to it through this mechanism without that being a
// deliberate, visible change to this assertion.
test('no market is overridden below two healthy sources', () => {
  for (const [feed, override] of Object.entries(MARKET_BOUNDS_OVERRIDES)) {
    if (override.minHealthyVenues === undefined) continue;
    assert.ok(
      override.minHealthyVenues >= 2,
      `${feed} is overridden to ${override.minHealthyVenues} healthy source(s), which removes all cross-checking`,
    );
  }
});
