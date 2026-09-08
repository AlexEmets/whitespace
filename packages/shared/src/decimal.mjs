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

/**
 * Fixed-point scale, in fractional DIGITS (not multipliers), for the three money types.
 * `PRICE` is derived from PRICE_DECIMALS rather than restated, so the two cannot drift.
 */
export const SCALE = {
  PRICE: Number(PRICE_DECIMALS), // 18
  COLLATERAL: 6, // USDW
  LEVERAGE: 2, // 1000 == 10.00x
};

/**
 * Converts a base-unit integer to a decimal string at an arbitrary scale. Accepts the
 * numeric strings node-postgres returns for NUMERIC/BIGINT columns, so indexed rows can
 * be serialised without ever passing through a JavaScript `number`.
 *
 *   toDecimalString(65001000000000000000000n, 18) === "65001.000000000000000000"
 *   toDecimalString(999000000n, 6)                === "999.000000"
 *
 * Differs from `formatFixed18` deliberately: that one strips trailing zeros for human
 * logs, this one keeps exactly `decimals` digits for a stable wire format.
 *
 * @param {bigint|string|number} raw
 * @param {number} decimals
 * @returns {string}
 */
export function toDecimalString(raw, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new TypeError(`decimals must be a non-negative integer, got ${decimals}`);
  }
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const digits = abs.toString();

  let result;
  if (decimals === 0) {
    result = digits;
  } else {
    const padded = digits.padStart(decimals + 1, '0');
    result = `${padded.slice(0, padded.length - decimals)}.${padded.slice(padded.length - decimals)}`;
  }
  return negative ? `-${result}` : result;
}

/**
 * Parses a decimal string into a base-unit bigint at an arbitrary scale.
 *
 * Deliberately STRICTER than `parseDecimalTo18`, and the difference is intentional:
 * that one truncates excess digits because a price feed must never round toward a more
 * favourable number, whereas this one THROWS, because over-precise input from an API
 * caller is a caller bug that should surface rather than be silently rounded away.
 * Do not "unify" them.
 *
 * @param {string|bigint|number} input
 * @param {number} decimals
 * @returns {bigint}
 */
export function parseDecimalToBigInt(input, decimals) {
  const s = String(input).trim();
  const match = DECIMAL_RE.exec(s);
  if (!match) {
    throw new TypeError(`not a plain decimal string: ${JSON.stringify(input)}`);
  }
  const [, sign, whole, frac = ''] = match;
  if (frac.length > decimals) {
    throw new RangeError(
      `input has ${frac.length} fractional digits, exceeds scale ${decimals}: ${input}`,
    );
  }
  const magnitude = BigInt(whole + frac.padEnd(decimals, '0'));
  return sign === '-' ? -magnitude : magnitude;
}
