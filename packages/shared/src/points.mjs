/**
 * Season-one points scoring — the single source of truth for how every point is earned.
 *
 * The indexer applies these functions to realised on-chain events and stores the result;
 * the API serves those totals; the web app reuses the very same functions to show the
 * portion accruing *right now* on an open position or on liquidity still sitting in the
 * pool. One implementation means the live counter on the page and the confirmed total in
 * the database can never disagree about the rules.
 *
 * Money and points are exact bigints. Points are carried at 6 decimals (POINTS_DECIMALS),
 * the same convention USDW uses, so a fractional point survives the wire as a decimal
 * string and never passes through a float. Every input scaled at 6 decimals (USDW amounts,
 * notional) cancels cleanly against the 6-decimal points scale — see the divisor comments.
 */

import { SCALE } from './decimal.mjs';

/** Fractional digits a points value carries on the wire. Matches USDW (SCALE.COLLATERAL). */
export const POINTS_DECIMALS = 6;
/** 10 ** POINTS_DECIMALS — one whole point in base units. */
export const POINTS_SCALE = 10n ** BigInt(POINTS_DECIMALS);

const COLLATERAL_SCALE = 10n ** BigInt(SCALE.COLLATERAL); // 1e6, USDW base units

function requireBigint(value, name) {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${name} must be a bigint, got ${typeof value}`);
  }
  return value;
}

function requireNonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${value}`);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Component 1 — Missions (one-time per wallet)
 * ------------------------------------------------------------------ */

/**
 * The mission catalogue. Order is the display order. `points` are whole points; the raw
 * base-unit value is derived so the two can never drift.
 * @type {ReadonlyArray<{ id: string, label: string, points: number }>}
 */
export const MISSIONS = Object.freeze([
  { id: 'first_market_trade', label: 'First market trade', points: 50 },
  { id: 'limit_filled', label: 'Limit order filled', points: 75 },
  { id: 'stop_triggered', label: 'Stop order triggered', points: 75 },
  { id: 'take_profit_hit', label: 'Take-profit executed', points: 75 },
  { id: 'stop_loss_hit', label: 'Stop-loss executed', points: 75 },
  { id: 'edit_tp_sl', label: 'Change TP / SL', points: 50 },
  { id: 'margin_edit', label: 'Add / remove margin', points: 50 },
  { id: 'partial_close', label: 'Partial close', points: 50 },
  { id: 'close_empty_wallet', label: 'Close with an empty wallet', points: 100 },
  { id: 'pool_deposit_claim', label: 'Deposit to pool and claim', points: 100 },
  { id: 'pool_withdraw_claim', label: 'Withdraw and claim', points: 100 },
  { id: 'survive_liquidation', label: 'Survive a liquidation', points: 50 },
].map(Object.freeze));

const MISSION_BY_ID = new Map(MISSIONS.map((m) => [m.id, m]));

/** @param {string} id */
export function isMissionId(id) {
  return MISSION_BY_ID.has(id);
}

/**
 * Base-unit points a mission is worth. Throws on an unknown id — a typo in a handler
 * would otherwise silently award zero and never be noticed.
 * @param {string} id
 * @returns {bigint}
 */
export function missionPointsRaw(id) {
  const mission = MISSION_BY_ID.get(id);
  if (mission == null) throw new RangeError(`unknown mission id: ${JSON.stringify(id)}`);
  return BigInt(mission.points) * POINTS_SCALE;
}

/** The most any wallet can earn from missions (all of them, once each). */
export const MAX_MISSION_POINTS_RAW = MISSIONS.reduce(
  (sum, m) => sum + BigInt(m.points) * POINTS_SCALE,
  0n,
);

/* ------------------------------------------------------------------ *
 * Component 2 — Time in market
 *   points = min(notional, 50k) * hours / 10_000
 * ------------------------------------------------------------------ */

/** Positions held for less than this are ignored entirely (not clamped up to it). */
export const MIN_HELD_SECONDS = 300; // 5 minutes
/** Notional above this does not earn more — caps a single whale position. */
export const NOTIONAL_CAP_RAW = 50_000n * COLLATERAL_SCALE; // 50k USDW
/** Per-UTC-day ceiling on time-in-market points. */
export const TIME_DAILY_CAP_RAW = 100n * POINTS_SCALE;

// notional(6dp) * seconds / (3600 * 10_000) yields points(6dp): the 1e6 scales cancel.
const TIME_DIVISOR = 36_000_000n;

/**
 * Points earned by holding one position, over the whole time it was held. Returns 0 for a
 * position held under the 5-minute floor. Notional is capped at 50k before scoring. The
 * per-day cap is NOT applied here — callers sum per day and cap with {@link creditUnderCap}.
 *
 * @param {{ notionalRaw: bigint, heldSeconds: number }} args
 *   notionalRaw: collateral * leverage, at 6 decimals (USDW).
 * @returns {bigint} points at 6 decimals
 */
export function timeInMarketPointsRaw({ notionalRaw, heldSeconds }) {
  requireBigint(notionalRaw, 'notionalRaw');
  requireNonNegativeInt(heldSeconds, 'heldSeconds');
  if (notionalRaw < 0n) throw new RangeError('notionalRaw must not be negative');
  if (heldSeconds < MIN_HELD_SECONDS) return 0n;
  const notional = notionalRaw > NOTIONAL_CAP_RAW ? NOTIONAL_CAP_RAW : notionalRaw;
  return (notional * BigInt(heldSeconds)) / TIME_DIVISOR;
}

/* ------------------------------------------------------------------ *
 * Component 3 — Day streak
 *   award(day) = 10 * multiplier(day); multiplier climbs 1.0 -> 1.5 over 7 days
 * ------------------------------------------------------------------ */

/** Base daily award before the streak multiplier. */
export const STREAK_BASE_RAW = 10n * POINTS_SCALE;
/** Days a position must be held to make a day "qualify" for the streak. */
export const STREAK_MIN_HELD_SECONDS = 600; // 10 minutes
/** Day at which the multiplier reaches its ceiling. */
export const STREAK_PEAK_DAY = 7;

/**
 * Streak multiplier in basis points for the Nth consecutive qualifying day.
 * Day 1 -> 10000 (x1.0); day 7+ -> 15000 (x1.5); linear in between.
 * @param {number} dayIndex 1-based
 * @returns {bigint} basis points
 */
export function streakMultiplierBps(dayIndex) {
  requireNonNegativeInt(dayIndex, 'dayIndex');
  if (dayIndex < 1) throw new RangeError('dayIndex is 1-based and must be >= 1');
  const clamped = dayIndex > STREAK_PEAK_DAY ? STREAK_PEAK_DAY : dayIndex;
  return 10_000n + (5_000n * BigInt(clamped - 1)) / BigInt(STREAK_PEAK_DAY - 1);
}

/**
 * Points awarded for the Nth consecutive qualifying day (base * multiplier), once per day.
 * @param {number} dayIndex 1-based
 * @returns {bigint} points at 6 decimals
 */
export function streakDayAwardRaw(dayIndex) {
  return (STREAK_BASE_RAW * streakMultiplierBps(dayIndex)) / 10_000n;
}

/* ------------------------------------------------------------------ *
 * Component 4 — Pool (LP)
 *   points = usdw-days / 1000
 * ------------------------------------------------------------------ */

/** Per-UTC-day ceiling on LP points (USDW is a free faucet token). */
export const LP_DAILY_CAP_RAW = 50n * POINTS_SCALE;

// balance(6dp) * seconds / (86400 * 1000) yields points(6dp): the 1e6 scales cancel.
const LP_DIVISOR = 86_400_000n;

/**
 * Points earned by liquidity of `balanceRaw` sitting in the pool for `heldSeconds`.
 * The per-day cap is NOT applied here — callers cap with {@link creditUnderCap}.
 *
 * @param {{ balanceRaw: bigint, heldSeconds: number }} args
 *   balanceRaw: USDW in the pool, at 6 decimals.
 * @returns {bigint} points at 6 decimals
 */
export function lpPointsRaw({ balanceRaw, heldSeconds }) {
  requireBigint(balanceRaw, 'balanceRaw');
  requireNonNegativeInt(heldSeconds, 'heldSeconds');
  if (balanceRaw < 0n) throw new RangeError('balanceRaw must not be negative');
  return (balanceRaw * BigInt(heldSeconds)) / LP_DIVISOR;
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/**
 * How much of `addRaw` may be credited today without breaching `capRaw`, given
 * `accruedTodayRaw` already credited. Never negative; zero once the cap is reached.
 * @param {bigint} accruedTodayRaw
 * @param {bigint} addRaw
 * @param {bigint} capRaw
 * @returns {bigint}
 */
export function creditUnderCap(accruedTodayRaw, addRaw, capRaw) {
  requireBigint(accruedTodayRaw, 'accruedTodayRaw');
  requireBigint(addRaw, 'addRaw');
  requireBigint(capRaw, 'capRaw');
  const remaining = capRaw - accruedTodayRaw;
  if (remaining <= 0n) return 0n;
  return addRaw < remaining ? addRaw : remaining;
}

/** The UTC day a unix timestamp (seconds) falls in — days since the epoch. */
export function utcDayIndex(unixSeconds) {
  requireNonNegativeInt(unixSeconds, 'unixSeconds');
  return Math.floor(unixSeconds / 86_400);
}

/**
 * Sum of the four components. Every argument is base-unit points; missing ones default to 0.
 * @param {{ missionsRaw?: bigint, timeRaw?: bigint, streakRaw?: bigint, lpRaw?: bigint }} parts
 * @returns {bigint}
 */
export function seasonTotalRaw(parts) {
  const { missionsRaw = 0n, timeRaw = 0n, streakRaw = 0n, lpRaw = 0n } = parts;
  return (
    requireBigint(missionsRaw, 'missionsRaw') +
    requireBigint(timeRaw, 'timeRaw') +
    requireBigint(streakRaw, 'streakRaw') +
    requireBigint(lpRaw, 'lpRaw')
  );
}
