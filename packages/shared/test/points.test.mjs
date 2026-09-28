import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POINTS_SCALE,
  MISSIONS,
  MAX_MISSION_POINTS_RAW,
  isMissionId,
  missionPointsRaw,
  MIN_HELD_SECONDS,
  NOTIONAL_CAP_RAW,
  timeInMarketPointsRaw,
  STREAK_PEAK_DAY,
  streakMultiplierBps,
  streakDayAwardRaw,
  lpPointsRaw,
  creditUnderCap,
  utcDayIndex,
  seasonTotalRaw,
  TIME_DAILY_CAP_RAW,
  LP_DAILY_CAP_RAW,
} from '../src/points.mjs';

const USDW = 10n ** 6n; // one USDW in base units
const P = POINTS_SCALE; // one point in base units

/* -------- Missions -------- */

test('mission catalogue has 12 unique ids and sums to 850 points', () => {
  const ids = new Set(MISSIONS.map((m) => m.id));
  assert.equal(ids.size, MISSIONS.length);
  assert.equal(MISSIONS.length, 12);
  const total = MISSIONS.reduce((s, m) => s + m.points, 0);
  assert.equal(total, 850);
  assert.equal(MAX_MISSION_POINTS_RAW, 850n * P);
});

test('missionPointsRaw returns the scaled whole-point value', () => {
  assert.equal(missionPointsRaw('first_market_trade'), 50n * P);
  assert.equal(missionPointsRaw('close_empty_wallet'), 100n * P);
});

test('missionPointsRaw throws on an unknown id rather than awarding zero', () => {
  assert.throws(() => missionPointsRaw('nope'), RangeError);
});

test('isMissionId recognises catalogue ids and rejects others', () => {
  assert.equal(isMissionId('survive_liquidation'), true);
  assert.equal(isMissionId('survive_liquidations'), false);
});

/* -------- Time in market -------- */

test('a position held under 5 minutes earns nothing (floor, not clamp)', () => {
  assert.equal(timeInMarketPointsRaw({ notionalRaw: 50_000n * USDW, heldSeconds: MIN_HELD_SECONDS - 1 }), 0n);
});

test('exactly 5 minutes qualifies', () => {
  // 12_400 notional for 300s: 12400 * 300 / 3600 / 10000 = 0.103333 points
  const pts = timeInMarketPointsRaw({ notionalRaw: 12_400n * USDW, heldSeconds: 300 });
  assert.equal(pts, (12_400n * USDW * 300n) / 36_000_000n);
  assert.equal(pts, 103_333n); // 0.103333 at 6dp
});

test('one hour of 12,400 notional earns 1.24 points', () => {
  const pts = timeInMarketPointsRaw({ notionalRaw: 12_400n * USDW, heldSeconds: 3600 });
  assert.equal(pts, 1_240_000n); // 1.240000
});

test('notional is capped at 50k before scoring', () => {
  const atCap = timeInMarketPointsRaw({ notionalRaw: 50_000n * USDW, heldSeconds: 3600 });
  const overCap = timeInMarketPointsRaw({ notionalRaw: 500_000n * USDW, heldSeconds: 3600 });
  assert.equal(overCap, atCap);
  assert.equal(atCap, 5_000_000n); // 50000/10000 = 5.0 points/hr
  assert.equal(NOTIONAL_CAP_RAW, 50_000n * USDW);
});

test('timeInMarketPointsRaw rejects a float or negative held time', () => {
  assert.throws(() => timeInMarketPointsRaw({ notionalRaw: USDW, heldSeconds: 1.5 }), TypeError);
  assert.throws(() => timeInMarketPointsRaw({ notionalRaw: USDW, heldSeconds: -1 }), TypeError);
  assert.throws(() => timeInMarketPointsRaw({ notionalRaw: -1n, heldSeconds: 3600 }), RangeError);
});

/* -------- Day streak -------- */

test('streak multiplier climbs from x1.0 on day 1 to x1.5 on day 7', () => {
  assert.equal(streakMultiplierBps(1), 10_000n);
  assert.equal(streakMultiplierBps(5), 13_333n); // ~x1.33, as shown on the card
  assert.equal(streakMultiplierBps(7), 15_000n);
});

test('streak multiplier is clamped past the peak day', () => {
  assert.equal(streakMultiplierBps(8), streakMultiplierBps(STREAK_PEAK_DAY));
  assert.equal(streakMultiplierBps(100), 15_000n);
});

test('streakMultiplierBps rejects a non-positive / non-integer day', () => {
  assert.throws(() => streakMultiplierBps(0), RangeError);
  assert.throws(() => streakMultiplierBps(2.5), TypeError);
});

test('day award is base 10 scaled by the multiplier', () => {
  assert.equal(streakDayAwardRaw(1), 10n * P);
  assert.equal(streakDayAwardRaw(7), 15n * P); // 10 * 1.5
  assert.equal(streakDayAwardRaw(5), (10n * P * 13_333n) / 10_000n);
});

/* -------- Pool (LP) -------- */

test('8,500 USDW for a full day earns 8.5 points', () => {
  const pts = lpPointsRaw({ balanceRaw: 8_500n * USDW, heldSeconds: 86_400 });
  assert.equal(pts, 8_500_000n); // 8.500000
});

test('LP points scale linearly with time and balance', () => {
  const halfDay = lpPointsRaw({ balanceRaw: 8_500n * USDW, heldSeconds: 43_200 });
  assert.equal(halfDay, 4_250_000n);
});

test('lpPointsRaw rejects negative balance', () => {
  assert.throws(() => lpPointsRaw({ balanceRaw: -1n, heldSeconds: 10 }), RangeError);
});

/* -------- Caps -------- */

test('creditUnderCap credits the full amount below the cap', () => {
  assert.equal(creditUnderCap(0n, 30n * P, TIME_DAILY_CAP_RAW), 30n * P);
});

test('creditUnderCap credits only the remaining room at the cap', () => {
  assert.equal(creditUnderCap(90n * P, 30n * P, TIME_DAILY_CAP_RAW), 10n * P);
});

test('creditUnderCap returns zero once the cap is reached or exceeded', () => {
  assert.equal(creditUnderCap(TIME_DAILY_CAP_RAW, 5n * P, TIME_DAILY_CAP_RAW), 0n);
  assert.equal(creditUnderCap(60n * P, 5n * P, LP_DAILY_CAP_RAW), 0n); // LP cap is 50
});

/* -------- Day index + totals -------- */

test('utcDayIndex buckets timestamps into UTC days', () => {
  assert.equal(utcDayIndex(0), 0);
  assert.equal(utcDayIndex(86_399), 0);
  assert.equal(utcDayIndex(86_400), 1);
});

test('seasonTotalRaw sums the four components and defaults missing ones to zero', () => {
  assert.equal(
    seasonTotalRaw({ missionsRaw: 500n * P, timeRaw: 214n * P, streakRaw: 128n * P, lpRaw: 96n * P }),
    938n * P,
  );
  assert.equal(seasonTotalRaw({ missionsRaw: 50n * P }), 50n * P);
});

test('seasonTotalRaw rejects a non-bigint component', () => {
  assert.throws(() => seasonTotalRaw({ missionsRaw: 5 }), TypeError);
});
