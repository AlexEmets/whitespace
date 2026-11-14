import { collateral, price } from './format.js';

/**
 * The LP vault's performance, from its settlement history.
 *
 * A vault share is worth `shareToAssetsPrice` USDW, and that price moves only at a settlement,
 * by the traders' net PnL, fees and funding. So the LP's return over a window is simply how
 * the share price changed between the settlement at the window's start and the latest one.
 *
 * Pure and exact: prices are 18-decimal bigints and every result is too, formatted as a
 * decimal string only at the end. Nothing here reads the clock — "now" is the latest
 * settlement, so the figures describe settled history and never extrapolate past it.
 */

const ONE = 10n ** 18n;
export const DAY_SECONDS = 86_400;
const YEAR_SECONDS = 365n * BigInt(DAY_SECONDS);

/** The windows the vault's return is reported over, besides "since the first settlement". */
export const PERFORMANCE_WINDOWS = [
  { id: '7d', seconds: 7 * DAY_SECONDS },
  { id: '30d', seconds: 30 * DAY_SECONDS },
] as const;

/** Days of share-price history sent for the chart, newest kept. */
export const MAX_SERIES_DAYS = 365;

export type SettlementPoint = { ts: number; sharePrice: bigint; totalAssets: bigint | null };

export type PerformanceWindow = {
  /** When the settlement the window is measured from happened. */
  from: number;
  sharePriceThen: string;
  /** The share price's fractional change, 18 dp: "0.012000…" is +1.2%. */
  change: string;
  /** That change annualised without compounding (APR), 18 dp. */
  apr: string;
};

export type VaultPerformance = {
  sharePrice: string;
  totalAssets: string | null;
  updatedAt: number;
  windows: { '7d': PerformanceWindow | null; '30d': PerformanceWindow | null; all: PerformanceWindow | null };
  /** The share price at the last settlement of each UTC day, oldest first. */
  series: Array<{ t: number; sharePrice: string }>;
};

function measure(then: SettlementPoint, now: SettlementPoint): PerformanceWindow | null {
  const elapsed = BigInt(now.ts - then.ts);
  if (elapsed <= 0n || then.sharePrice <= 0n) return null;
  const change = ((now.sharePrice - then.sharePrice) * ONE) / then.sharePrice;
  return {
    from: then.ts,
    sharePriceThen: price(then.sharePrice)!,
    change: price(change)!,
    apr: price((change * YEAR_SECONDS) / elapsed)!,
  };
}

/**
 * Performance from settlements in time order (oldest first). Null when there are none.
 *
 * A window starts at the newest settlement no later than `latest − window`. If settlements
 * paused, that one can be older than the window, and the APR is annualised over the time that
 * actually passed. A window is null when the vault is younger than it — there is no honest
 * 30-day figure for a 20-day-old vault.
 */
export function vaultPerformance(points: SettlementPoint[]): VaultPerformance | null {
  if (points.length === 0) return null;
  const latest = points[points.length - 1]!;

  const startOf = (seconds: number): SettlementPoint | null => {
    const cutoff = latest.ts - seconds;
    let found: SettlementPoint | null = null;
    for (const p of points) {
      if (p.ts > cutoff) break;
      found = p;
    }
    return found;
  };
  const windowOver = (seconds: number) => {
    const start = startOf(seconds);
    return start ? measure(start, latest) : null;
  };

  const lastOfDay = new Map<number, SettlementPoint>();
  for (const p of points) lastOfDay.set(Math.floor(p.ts / DAY_SECONDS), p);
  const series = [...lastOfDay.values()]
    .slice(-MAX_SERIES_DAYS)
    .map((p) => ({ t: p.ts, sharePrice: price(p.sharePrice)! }));

  return {
    sharePrice: price(latest.sharePrice)!,
    totalAssets: collateral(latest.totalAssets),
    updatedAt: latest.ts,
    windows: {
      '7d': windowOver(PERFORMANCE_WINDOWS[0].seconds),
      '30d': windowOver(PERFORMANCE_WINDOWS[1].seconds),
      all: measure(points[0]!, latest),
    },
    series,
  };
}
