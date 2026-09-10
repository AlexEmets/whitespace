/**
 * Exact, bigint-only decimal utilities for anything that represents money or price in
 * this app. This module is the single place that is allowed to reason about scale
 * (number of decimals). Every other module must go through it rather than dividing or
 * multiplying a raw value itself.
 *
 * THE RULE — the one thing to remember about a monetary value in this app:
 *
 *   - a `bigint` is a RAW, on-chain, scale-carrying integer. `65001000000000000000000n`
 *     at 18 decimals is 65,001.00. This is what viem/wagmi decodes out of a contract
 *     read, and what a contract write has to be handed back.
 *   - a `string` is a HUMAN decimal from the read API, with the scale already applied:
 *     `"65001.000000000000000000"`. services/api emits every monetary field this way
 *     (its src/format.ts -> @whitespace/shared `toDecimalString`), always with exactly
 *     `decimals` fraction digits.
 *   - both are exact. Neither may ever be a JS `number`.
 *
 * Why the API's form and not the raw one — the two were built against the same one-line
 * spec clause and read it in opposite directions, so this is a decision, not a
 * coincidence. A human decimal carries its own scale in its digits: a consumer that
 * passes the wrong `decimals` still renders a number of the right magnitude, wrong only
 * in trailing precision. Get `decimals` wrong on a raw integer and the screen shows a
 * figure 10^n too large — silently and plausibly, "999.00 USDW" rendering as
 * "999,000,000.00 USDW". In a leveraged trading UI the failure mode has to be visible,
 * so the wire format is the one that cannot hide it.
 *
 * The tradeoff this costs us, stated honestly: a string can no longer be interpreted
 * without knowing its scale, so `formatMoney`/`toRawUnits` need `decimals` to do
 * anything at all with one, and a caller that only has the string (no scale) is stuck.
 * Price is 18 decimals, collateral (USDW) 6, leverage 2 — all three live in
 * src/lib/config.ts, and every call site names one of them.
 *
 * Any `number` input is rejected at runtime, not just by the TypeScript types —
 * TypeScript types are erased at build time and a stray `Number(x)` upstream must not
 * silently become an accepted input here.
 *
 * (Background: docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md and the
 * phase-5 task brief.)
 */

import { COLLATERAL_DECIMALS, LEVERAGE_DECIMALS, PRICE_DECIMALS_NUM } from './config';

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
 * Parses a value that is ALREADY a raw scaled integer — a bigint, or the base-10 digits
 * of one (`"65001000000000000000000"` for an 18-decimal price) — into a bigint. It does
 * not accept a decimal point, deliberately: at 18 decimals there is no digit pattern
 * that distinguishes a raw integer from a human decimal, so the only defence against
 * reading one as the other is refusing the shape outright.
 *
 * NOT for read-API payloads: those are human decimals (see the module header) and this
 * function throws on them by design — that throw is what surfaced the original
 * API/web mismatch instead of rendering a price 10^18 too large. Use `toRawUnits` for an
 * API value, `parseHumanDecimal` for user-typed input, and this only for raw sources:
 * on-chain reads that already gave you digits, deployment artifacts, event log data.
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
 * Applies the module header's rule to get at the raw scaled bigint inside either form: a
 * `bigint` is already raw and passes through untouched, a `string` is a human decimal
 * from the API and is scaled up by `10^decimals`.
 *
 * This is the single place that branch is written, so anything that needs to reach
 * *inside* a monetary value — arithmetic, a contract-call argument — resolves it exactly
 * the way `formatMoney` does. Two forms of the same digits are NOT interchangeable here:
 * `toRawUnits(999000000n, 6)` is 999.00, `toRawUnits('999000000', 6)` is 999 million.
 */
export function toRawUnits(value: MoneyInput, decimals: number): bigint {
  assertNotNumber(value);
  return typeof value === 'bigint' ? value : parseHumanDecimal(value, decimals);
}

/**
 * The three scales this app actually has, bound into named resolvers — the mirror image
 * of services/api/src/format.ts's `price()` / `collateral()` / `leverage()`, which is
 * where the values these read come from. The API names the scale on the way out; naming
 * it the same way on the way in means a field can be traced end to end without either
 * side re-deciding what its digits mean.
 *
 * Prefer these to a bare `toRawUnits(value, SOME_DECIMALS)` at a call site. The scale of
 * a given field is a property of the wire contract, not a local choice, and a hand-passed
 * `decimals` is the one argument nothing can check for you: pass 6 where 18 was meant and
 * you get a silently wrong number of exactly the right shape.
 */
export const priceToRaw = (value: MoneyInput): bigint => toRawUnits(value, PRICE_DECIMALS_NUM);
export const collateralToRaw = (value: MoneyInput): bigint => toRawUnits(value, COLLATERAL_DECIMALS);
export const leverageToRaw = (value: MoneyInput): bigint => toRawUnits(value, LEVERAGE_DECIMALS);

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
 * `value` follows the module header's rule: a raw scaled `bigint`, or a human decimal
 * `string` exactly as the read API delivers it. `decimals` is the scale of the value in
 * both cases. It is never a JS `number` — passing one throws `MoneyTypeError`
 * synchronously, by design (see the accompanying test asserting this).
 */
export function formatMoney(value: MoneyInput, decimals: number, opts: FormatMoneyOptions = {}): string {
  assertNotNumber(value);
  const { fractionDigits = 2, grouping = true, signDisplay = false } = opts;
  const raw = toRawUnits(value, decimals);

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

/** Formats a PRECISION_2 leverage value: raw `1000n` from the chain, or the API's
 * `"10.00"` — both render `"10.00x"`. */
export function formatLeverage(value: MoneyInput): string {
  assertNotNumber(value);
  return `${formatMoney(value, 2, { grouping: false, fractionDigits: 2 })}x`;
}

/**
 * Abbreviated magnitude for dense UI where the full figure does not fit — a markets rail
 * row, a tile. `"38.2M"`, `"1.4K"`, `"999.00"`.
 *
 * The scaling is done by dividing the RAW bigint by the unit, never by converting to a
 * JS number first, so this stays on the same exact-arithmetic footing as `formatMoney`
 * (which it delegates to for the actual digits). It is lossy *by intent* — it drops
 * precision to save space — so it must only ever be used for a label. Anything a trader
 * acts on, or that feeds a transaction, keeps the full figure.
 */
export function formatCompactMoney(value: MoneyInput, decimals: number): string {
  assertNotNumber(value);
  const raw = toRawUnits(value, decimals);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const sign = negative ? '-' : '';

  for (const [unit, suffix] of [
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K'],
  ] as const) {
    if (abs >= unit * scale) {
      return `${sign}${formatMoney(abs / unit, decimals, { fractionDigits: 1, grouping: false })}${suffix}`;
    }
  }
  return `${sign}${formatMoney(abs, decimals, { fractionDigits: 2 })}`;
}

/** Formats a bps bigint (e.g. `50n` -> `"0.50%"`). */
export function formatBps(bps: bigint): string {
  assertNotNumber(bps);
  return `${formatMoney(bps, 2, { grouping: false, fractionDigits: 2 })}%`;
}
