import { timeInMarketPointsRaw, lpPointsRaw } from '@whitespace/shared/points';
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

/** Unrealised time-in-market points across the open positions, as of `nowSeconds`. */
export function pendingTimePointsRaw(positions: PositionSummary[], nowSeconds: number): bigint {
  let sum = 0n;
  for (const p of positions) {
    const notionalRaw = (toRawUnits(p.collateral, COLLATERAL_DECIMALS) * toRawUnits(p.leverage, LEVERAGE_DECIMALS)) / 100n;
    const heldSeconds = Math.max(0, Math.floor(nowSeconds - p.openedAt));
    sum += timeInMarketPointsRaw({ notionalRaw, heldSeconds });
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
