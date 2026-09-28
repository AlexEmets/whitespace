import { toDecimalString, SCALE } from '@whitespace/shared/decimal';

// Re-exported so routes never need to import @whitespace/shared directly —
// keeps the "never format money by hand" rule enforced from one place.
export { SCALE };

/** Format a raw base-unit value as a decimal string. Accepts `number` only
 * for values pg already returns as a native JS number (Postgres `integer`
 * columns, e.g. leverage — safe, since int32 always fits exactly in a JS
 * number). NUMERIC/BIGINT-backed money values arrive as strings from pg and
 * must never be widened to `number` before reaching here. */
export function money(raw: string | bigint | number | null, decimals: number): string | null {
  if (raw === null) return null;
  return toDecimalString(raw, decimals);
}

export function price(raw: string | bigint | null): string | null {
  return money(raw, SCALE.PRICE);
}

export function collateral(raw: string | bigint | null): string | null {
  return money(raw, SCALE.COLLATERAL);
}

export function leverage(raw: number | string | bigint | null): string | null {
  if (raw === null) return null;
  return money(raw, SCALE.LEVERAGE);
}

/** Format a raw uint256-sourced identifier (orderId, tradeId — from a
 * NUMERIC column, so it arrives as a string) as a plain integer string.
 * Never a JS number — these can exceed 2^53. */
export function id(raw: string | bigint | null): string | null {
  if (raw === null) return null;
  return money(raw, 0);
}

/** percentProfit as the contract defines it: a signed PERCENT with 6 decimals
 * (OstiumPairInfos.getTradeValuePure divides collateral * percentProfit by 1e6 * 100), so
 * raw -30768 is "-0.030768" (%). Not a PRECISION_18 value. */
export function percent6(raw: string | bigint | null): string | null {
  return money(raw, 6);
}
