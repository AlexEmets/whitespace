/**
 * Exact bigint decimal utilities. Prices carry exactly 18 decimals everywhere in this
 * codebase; floating point must never represent money. The only place a float is
 * permitted is deriving a dimensionless EMA smoothing coefficient (see
 * services/price-publisher/src/ema.mjs), never a price.
 */

export const PRICE_DECIMALS = 18n;
export const PRICE_SCALE = 10n ** PRICE_DECIMALS; // 1e18

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses a base-10 decimal string (as returned by every venue's REST/WS API, e.g.
 * "65001.23000000") into an exact 18-decimal fixed-point bigint. Never touches
 * floating point. Extra fractional digits beyond 18 are truncated, not rounded — a
 * price feed must never round toward a more favorable number.
 *
 * @param {string|number} input
 * @returns {bigint}
 */
export function parseDecimalTo18(input) {
  const s = String(input).trim();
  const match = DECIMAL_RE.exec(s);
  if (!match) {
    throw new Error(`parseDecimalTo18: not a decimal number: ${JSON.stringify(input)}`);
  }
  const [, sign, whole, frac = ''] = match;
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  const value = BigInt(whole) * PRICE_SCALE + BigInt(fracPadded === '' ? '0' : fracPadded);
  return sign === '-' ? -value : value;
}

/**
 * Formats an 18-decimal fixed-point bigint back to a plain decimal string. Debugging /
 * logging only — never round-trip this through a float either.
 * @param {bigint} value
 */
export function formatFixed18(value) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / PRICE_SCALE;
  const frac = (abs % PRICE_SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/**
 * Exact integer basis-points ratio: |numerator| * 10000 / denominator, truncated.
 * Returns null if denominator is not strictly positive (nothing sane to divide by).
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @returns {bigint|null}
 */
export function bpsOf(numerator, denominator) {
  if (denominator <= 0n) return null;
  const n = numerator < 0n ? -numerator : numerator;
  return (n * 10_000n) / denominator;
}

/**
 * bps deviation of `value` from `reference`: |value - reference| * 10000 / reference.
 * @param {bigint} value
 * @param {bigint} reference
 * @returns {bigint|null}
 */
export function deviationBps(value, reference) {
  if (reference <= 0n) return null;
  return bpsOf(value - reference, reference);
}
