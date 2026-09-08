/**
 * Exact, bigint-only decimal utilities for anything that represents money or price in
 * this app. This module is the single place that is allowed to reason about scale
 * (number of decimals). Every other module must go through it rather than dividing or
 * multiplying a raw value itself.
 *
 * Why this exists (see docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md
 * and the phase-5 task brief): price carries 18 decimals, collateral (USDW) 6, leverage
 * 2. The API contract (D3) transports every monetary value as a *decimal string* that is
 * the raw on-chain scaled integer (e.g. "65001000000000000000000" for a price of
 * 65,001.00 at 18 decimals) — never a JSON number, which silently loses precision above
 * 2^53 and is exactly the shape a leveraged trading UI cannot tolerate being wrong about.
 *
 * Every function here either takes a `bigint` or a strict base-10 integer `string`. Any
 * `number` input is rejected at runtime, not just by the TypeScript types — TypeScript
 * types are erased at build time and a stray `Number(x)` upstream must not silently
 * become an accepted input here.
 */

/** A monetary value as it is allowed to travel through this app: never a JS `number`. */
export type MoneyInput = bigint | string;

export class MoneyTypeError extends TypeError {
  constructor(value: unknown) {
    super(
      `money: refused a JS "number" (${String(value)}) as a monetary value — money must ` +
        'be a bigint or a decimal string, parsed/formatted only through src/lib/money.ts',
    );
    this.name = 'MoneyTypeError';
  }
}

/** Throws if `value` is a JS `number`. Every public function below calls this first. */
function assertNotNumber(value: unknown): void {
  if (typeof value === 'number') {
    throw new MoneyTypeError(value);
  }
}

const INTEGER_STRING_RE = /^(-?)(\d+)$/;
const DECIMAL_STRING_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses a raw scaled-integer decimal string (as delivered by the API per D3, e.g.
 * `"65001000000000000000000"` for an 18-decimal price) into a bigint. This is NOT a
 * human decimal parser — it does not accept a decimal point. Use `parseHumanDecimal` for
 * user-typed input such as a collateral amount typed into a form field.
 */
export function parseRawUnits(value: MoneyInput): bigint {
  assertNotNumber(value);
  if (typeof value === 'bigint') return value;
  const s = value.trim();
  if (!INTEGER_STRING_RE.test(s)) {
    throw new Error(`money: not a raw integer decimal string: ${JSON.stringify(value)}`);
  }
  return BigInt(s);
}

/**
 * Parses a human-typed decimal string (e.g. "1250.5" typed into a collateral field) into
 * an exact bigint scaled by `10^decimals`. Extra fractional digits beyond `decimals` are
 * truncated, never rounded up — never let a UI parse error round a trader's input in
 * their favor.
 */
export function parseHumanDecimal(input: MoneyInput, decimals: number): bigint {
  assertNotNumber(input);
  const s = String(input).trim();
  const match = DECIMAL_STRING_RE.exec(s);
  if (!match) {
    throw new Error(`money: not a decimal number: ${JSON.stringify(input)}`);
  }
  const [, sign = '', whole = '0', frac = ''] = match;
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(whole) * scale + BigInt(fracPadded === '' ? '0' : fracPadded);
  return sign === '-' ? -value : value;
}

/**
 * Formats a scaled bigint back into an exact, un-rounded plain decimal string (e.g.
 * `999000000n` at 6 decimals -> `"999"`). Trailing zeros are trimmed. This is the exact
 * inverse of `parseRawUnits`/`parseHumanDecimal` — safe for round-tripping into another
 * bigint, not for direct display (use `formatMoney` for display formatting with fixed
 * fraction digits and thousands separators).
 */
export function formatExact(value: bigint, decimals: number): string {
  assertNotNumber(value);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fracDigits = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fracDigits ? `.${fracDigits}` : ''}`;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FormatMoneyOptions {
  /** Fixed number of fraction digits to display. Default 2. */
  fractionDigits?: number;
  /** Insert thousands separators into the integer part. Default true. */
  grouping?: boolean;
  /** Prepend a "+" sign for positive values (useful for signed PnL). Default false. */
  signDisplay?: boolean;
}

/**
 * The display formatter: exact bigint arithmetic in, a fixed-fraction-digit,
 * thousands-grouped decimal string out. Rounds half-up on the bigint remainder (never
 * touches floating point). This is the function every component should call to put a
 * price, collateral amount, or PnL figure on screen.
 *
 * `value` may be the raw scaled bigint, or the raw scaled-integer string exactly as the
 * API delivers it (per D3). It is never a JS `number` — passing one throws
 * `MoneyTypeError` synchronously, by design (see the accompanying test asserting this).
 */
export function formatMoney(value: MoneyInput, decimals: number, opts: FormatMoneyOptions = {}): string {
  assertNotNumber(value);
  const { fractionDigits = 2, grouping = true, signDisplay = false } = opts;
  const raw = typeof value === 'bigint' ? value : parseRawUnits(value);

  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  let whole = abs / scale;
  let frac = abs % scale;

  // Round the fractional part half-up to `fractionDigits`, in bigint.
  if (fractionDigits < decimals) {
    const dropped = decimals - fractionDigits;
    const dropScale = 10n ** BigInt(dropped);
    const keepScale = 10n ** BigInt(fractionDigits);
    let kept = frac / dropScale;
    const remainder = frac % dropScale;
    if (remainder * 2n >= dropScale) {
      kept += 1n;
      if (kept >= keepScale) {
        kept -= keepScale;
        whole += 1n;
      }
    }
    frac = kept;
  } else if (fractionDigits > decimals) {
    frac = frac * 10n ** BigInt(fractionDigits - decimals);
  }

  const fracStr = frac.toString().padStart(fractionDigits, '0');
  const wholeStr = grouping ? groupThousands(whole.toString()) : whole.toString();
  const sign = negative ? '-' : signDisplay ? '+' : '';
  const body = fractionDigits > 0 ? `${wholeStr}.${fracStr}` : wholeStr;
  return `${sign}${body}`;
}

/** Formats a PRECISION_2 leverage value (e.g. raw `1000` -> `"10.00x"`). */
export function formatLeverage(value: MoneyInput): string {
  assertNotNumber(value);
  return `${formatMoney(value, 2, { grouping: false, fractionDigits: 2 })}x`;
}

/** Formats a bps bigint (e.g. `50n` -> `"0.50%"`). */
export function formatBps(bps: bigint): string {
  assertNotNumber(bps);
  return `${formatMoney(bps, 2, { grouping: false, fractionDigits: 2 })}%`;
}
