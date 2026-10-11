import { MIN_HELD_SECONDS, timeInMarketPointsRaw, lpPointsRaw } from '@whitespace/shared/points';
import { toRawUnits } from './money';
import { COLLATERAL_DECIMALS, LEVERAGE_DECIMALS } from './config';
import type { PositionSummary } from './types';

/**
 * The points the page shows accruing in real time. The confirmed season totals come from the
 * indexer via GET /points/:address; these two functions add the part that has not been
 * realised on-chain yet — time on positions still open, and usdw-days on liquidity still in
 * the pool — using the exact same scoring rules the indexer will apply when they settle
 * (@whitespace/shared/points). The page re-evaluates them once a second against a ticking
 * clock, so the number climbs the way it will in the ledger, never ahead of it.
 */

function notionalRaw(p: PositionSummary): bigint {
  return (toRawUnits(p.collateral, COLLATERAL_DECIMALS) * toRawUnits(p.leverage, LEVERAGE_DECIMALS)) / 100n;
}

/** Unrealised time-in-market points across the open positions, as of `nowSeconds`. */
export function pendingTimePointsRaw(positions: PositionSummary[], nowSeconds: number): bigint {
  let sum = 0n;
  for (const p of positions) {
    const notional = notionalRaw(p);
    const heldSeconds = Math.max(0, Math.floor(nowSeconds - p.openedAt));
    sum += timeInMarketPointsRaw({ notionalRaw: notional, heldSeconds });
  }
  return sum;
}

/** Unrealised LP points on `balanceRaw` USDW since it last accrued at `sinceSeconds`. */
export function pendingLpPointsRaw(
  balanceRaw: bigint | null,
  sinceSeconds: number | null,
  nowSeconds: number,
): bigint {
  if (balanceRaw == null || balanceRaw <= 0n || sinceSeconds == null) return 0n;
  const heldSeconds = Math.max(0, Math.floor(nowSeconds - sinceSeconds));
  return lpPointsRaw({ balanceRaw, heldSeconds });
}

/**
 * Decimal places that keep a live counter visibly moving: enough that its last digit turns
 * over about ten times a second at `ratePerSecond`, but never past the ledger's six and never
 * under `minDp`. 100 USDW in the pool earns 0.1 pt a day — at a fixed three places that
 * counter changed once every 2.4 hours and looked frozen.
 */
export function liveDecimals(ratePerSecond: number, minDp: number, maxDp = 6): number {
  if (!(ratePerSecond > 0) || !Number.isFinite(ratePerSecond)) return minDp;
  const dp = Math.ceil(-Math.log10(ratePerSecond / 10));
  return Math.min(maxDp, Math.max(minDp, dp));
}

/** Points per second from the raw (6-decimal) points a counter gains over a day. */
export function ratePerSecond(rawPerDay: bigint): number {
  return Number(rawPerDay) / 1e6 / 86_400;
}

/**
 * Time-in-market points a day at the pace the counter is moving right now: only positions
 * already past the five-minute floor. One still under it adds nothing until it crosses —
 * counting it here made the page size the total's decimals for motion that was not happening,
 * and the total sat still.
 */
export function timePointsPerDayRaw(positions: PositionSummary[], nowSeconds: number): bigint {
  let sum = 0n;
  for (const p of positions) {
    if (nowSeconds - p.openedAt < MIN_HELD_SECONDS) continue;
    sum += timeInMarketPointsRaw({ notionalRaw: notionalRaw(p), heldSeconds: 86_400 });
  }
  return sum;
}

/**
 * The open positions still under the five-minute floor: how long until the first of them
 * starts counting, and how far through its wait it is (0–1). Null when none is waiting.
 */
export function timeWarmup(
  positions: PositionSummary[],
  nowSeconds: number,
): { secondsLeft: number; progress: number; waiting: number } | null {
  let oldestHeld = -1;
  let waiting = 0;
  for (const p of positions) {
    const held = Math.max(0, nowSeconds - p.openedAt);
    if (held >= MIN_HELD_SECONDS) continue;
    waiting += 1;
    if (held > oldestHeld) oldestHeld = held;
  }
  if (waiting === 0) return null;
  return { secondsLeft: MIN_HELD_SECONDS - oldestHeld, progress: oldestHeld / MIN_HELD_SECONDS, waiting };
}
