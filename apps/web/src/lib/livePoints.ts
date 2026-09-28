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
