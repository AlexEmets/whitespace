import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDegraded, canSubmitLiquidation } from '../src/degradedMode.mjs';
import { MIN_HEALTHY_VENUES } from '@whitespace/shared/bounds';

test('isDegraded is true below MIN_HEALTHY_VENUES and false at/above it', () => {
  assert.equal(isDegraded(MIN_HEALTHY_VENUES - 1), true);
  assert.equal(isDegraded(MIN_HEALTHY_VENUES), false);
  assert.equal(isDegraded(MIN_HEALTHY_VENUES + 1), false);
  assert.equal(isDegraded(0), true);
});

test('canSubmitLiquidation suppresses liquidation while degraded, defaulting to not-liquidate', () => {
  const result = canSubmitLiquidation({ healthyVenueCount: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'degraded_liquidations_suppressed');
});

test('canSubmitLiquidation allows liquidation once healthy venue count meets the minimum', () => {
  const result = canSubmitLiquidation({ healthyVenueCount: MIN_HEALTHY_VENUES });
  assert.equal(result.ok, true);
});

test('canSubmitLiquidation honors a caller-supplied minimum override', () => {
  assert.equal(canSubmitLiquidation({ healthyVenueCount: 3, minHealthyVenues: 4 }).ok, false);
  assert.equal(canSubmitLiquidation({ healthyVenueCount: 4, minHealthyVenues: 4 }).ok, true);
});
