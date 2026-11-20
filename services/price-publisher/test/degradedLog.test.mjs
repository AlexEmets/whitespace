import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDegradedLine } from '../src/degradedLog.mjs';

const base = { healthyCount: 1, minHealthyVenues: 2, healthyVenues: ['whitebit_perp'] };

test('names a stale venue with its age and the bound', () => {
  const line = formatDegradedLine({
    feed: 'WBT/USD',
    aggregate: { ...base, rejected: [{ tick: { venue: 'whitebit' }, reason: 'stale', detail: { ageMs: 9123, boundMs: 8000 } }] },
    mark: 59n,
    venues: ['whitebit', 'whitebit_perp'],
  });
  assert.equal(line, '[price-publisher] WBT/USD DEGRADED: healthy=1/2 venues=[whitebit_perp] rejected=[whitebit:stale 9123ms>8000ms] mark=59');
});

test('names a wide spread and a deviant venue with their bps and bounds', () => {
  const line = formatDegradedLine({
    feed: 'WBT/USD',
    aggregate: {
      healthyCount: 0,
      minHealthyVenues: 2,
      healthyVenues: [],
      rejected: [
        { tick: { venue: 'whitebit' }, reason: 'wide_spread', detail: { spreadBps: 14n, boundBps: 10n } },
        { tick: { venue: 'whitebit_perp' }, reason: 'deviant', detail: { deviationBps: 61n, boundBps: 50n } },
      ],
    },
    mark: 1n,
    venues: ['whitebit', 'whitebit_perp'],
  });
  assert.match(line, /rejected=\[whitebit:wide_spread 14bps>10bps,whitebit_perp:deviant 61bps>50bps\]/);
});

test('reports a connected venue that has no book at all as no_book', () => {
  const line = formatDegradedLine({ feed: 'WBT/USD', aggregate: { ...base, rejected: [] }, mark: 1n, venues: ['whitebit', 'whitebit_perp'] });
  assert.match(line, /rejected=\[whitebit:no_book\]/);
});

test('falls back to the bare reason when a rejection carries no detail', () => {
  const line = formatDegradedLine({
    feed: 'BTC/USD',
    aggregate: { ...base, healthyVenues: ['okx'], rejected: [{ tick: { venue: 'bybit' }, reason: 'invalid_quote' }] },
    mark: 1n,
    venues: ['okx', 'bybit'],
  });
  assert.match(line, /rejected=\[bybit:invalid_quote\]/);
});
