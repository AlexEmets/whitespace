import { formatMoney, toRawUnits } from './money';

/** The API sends returns as fractions at 18 decimals: "0.006054…" is 0.61%. */
const FRACTION_DECIMALS = 18;

/**
 * A return as a signed percentage, "+0.61%" / "-1.04%", rounded in bigint. A value that
 * rounds to nothing reads "0.00%" — never "-0.00%", which would claim a loss nobody can see.
 */
export function formatReturn(fraction: string, fractionDigits = 2): string {
  const percent = toRawUnits(fraction, FRACTION_DECIMALS) * 100n;
  const shown = formatMoney(percent, FRACTION_DECIMALS, { fractionDigits, signDisplay: true });
  return /^[+-]0\.0+$/.test(shown) ? `${shown.slice(1)}%` : `${shown}%`;
}

/** Whether a return is below zero, for colouring it. */
export function isLoss(fraction: string): boolean {
  return toRawUnits(fraction, FRACTION_DECIMALS) < 0n;
}

/** A share is worth exactly 1 USDW when the vault starts; the chart's reference line. */
export const PAR = 1;

export interface SharePriceGeometry {
  /** A step line: flat between settlements, a vertical move at each one. */
  line: string;
  /** The line closed down to the bottom of the box, for the fill. */
  area: string;
  /** Where a share price of exactly 1 USDW sits. */
  parY: number;
}

/**
 * The share-price history laid out in a `width`×`height` box. Steps, not slopes: the price
 * moves only when the vault settles, and a diagonal would draw gains nobody had. Points are
 * placed by time, so a pause in settlements is a long flat stretch rather than squeezed out,
 * and the range always includes par, so "above the line" means LPs are up. Display-only float
 * maths. Null for fewer than two points.
 */
export function sharePriceGeometry(
  series: Array<{ t: number; sharePrice: string }>,
  width: number,
  height: number,
  pad = 4,
): SharePriceGeometry | null {
  if (series.length < 2) return null;
  const values = series.map((p) => Number(p.sharePrice));
  const t0 = series[0]!.t;
  const t1 = series[series.length - 1]!.t;
  const lo = Math.min(PAR, ...values);
  const hi = Math.max(PAR, ...values);
  const span = hi - lo || 1;
  const x = (t: number) => pad + ((t - t0) * (width - 2 * pad)) / (t1 - t0 || 1);
  const y = (v: number) => pad + ((hi - v) * (height - 2 * pad)) / span;
  const r = (n: number) => Math.round(n * 100) / 100;

  let line = `M${r(x(t0))} ${r(y(values[0]!))}`;
  for (let i = 1; i < series.length; i++) line += ` H${r(x(series[i]!.t))} V${r(y(values[i]!))}`;
  return { line, area: `${line} V${height} H${r(x(t0))} Z`, parY: r(y(PAR)) };
}
