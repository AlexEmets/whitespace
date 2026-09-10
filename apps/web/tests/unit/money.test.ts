import { describe, expect, it } from 'vitest';
import {
  MoneyTypeError,
  formatBps,
  formatCompactMoney,
  formatExact,
  formatLeverage,
  formatMoney,
  parseHumanDecimal,
  parseRawUnits,
} from '@/lib/money';

// Real numbers from deployments/1874-operational.json's proofTrade — an actual executed
// open+close on Whitechain testnet 1874, not synthetic fixtures.
// The artifact records the raw, scale-carrying on-chain integers, so they are bigints
// here — the module header's rule: a bigint is raw, a string would be a human decimal.
const REAL_OPEN_PRICE = 65001000000000000000000n; // raw, 18 decimals -> 65,001.00
const REAL_COLLATERAL = 999000000n; // raw, 6 decimals -> 999.00
// The deployment report stores this as a bare JSON number (1000) — this test file reads
// it back as a bigint, the raw PRECISION_2 value the chain holds, rather than passing the
// deployment file's own number type through (API contract D3: never a JSON number).
const REAL_LEVERAGE = 1000n; // PRECISION_2 -> 10.00x
const REAL_TRADER_BEFORE = 10000000000n; // raw, 6 decimals -> 10,000.00
const REAL_TRADER_AFTER = 9998692628n; // raw, 6 decimals -> 9,998.692628 (exact), 9,998.69 (2dp)

describe('formatMoney against deployments/1874-operational.json real numbers', () => {
  it('formats the real open price (18 decimals) as 65,001.00', () => {
    expect(formatMoney(REAL_OPEN_PRICE, 18)).toBe('65,001.00');
  });

  it('formats the real collateral (6 decimals) as 999.00', () => {
    expect(formatMoney(REAL_COLLATERAL, 6)).toBe('999.00');
  });

  it('formats the real leverage (PRECISION_2) as 10.00x', () => {
    expect(formatLeverage(REAL_LEVERAGE)).toBe('10.00x');
  });

  it('formats trader balance before/after the real trade with grouping', () => {
    expect(formatMoney(REAL_TRADER_BEFORE, 6)).toBe('10,000.00');
    expect(formatMoney(REAL_TRADER_AFTER, 6)).toBe('9,998.69');
  });

  it('formatExact preserves the full 6-decimal precision of the real post-trade balance', () => {
    expect(formatExact(REAL_TRADER_AFTER, 6)).toBe('9998.692628');
  });

  it('accepts a bigint directly, not only a string', () => {
    expect(formatMoney(65001000000000000000000n, 18)).toBe('65,001.00');
  });
});

describe('formatMoney: general correctness', () => {
  it('rounds half-up on the dropped fractional digits, in bigint', () => {
    // 1.005 at 3 decimals -> raw 1005n; formatted to 2dp should round to 1.01 (half-up),
    // never through float (0.005 is not exactly representable in binary floating point,
    // which is exactly the class of bug this module exists to prevent).
    expect(formatMoney(1005n, 3, { fractionDigits: 2 })).toBe('1.01');
  });

  it('does not round when fractionDigits >= decimals', () => {
    expect(formatMoney(500000n, 6, { fractionDigits: 6 })).toBe('0.500000');
  });

  it('formats negative values with a leading minus, grouped', () => {
    expect(formatMoney(-1234567890n, 6, { fractionDigits: 2 })).toBe('-1,234.57');
  });

  it('signDisplay prepends + for positive values only', () => {
    expect(formatMoney(1500000n, 6, { signDisplay: true })).toBe('+1.50');
    expect(formatMoney(-1500000n, 6, { signDisplay: true })).toBe('-1.50');
    expect(formatMoney(0n, 6, { signDisplay: true })).toBe('+0.00');
  });

  it('grouping can be disabled', () => {
    expect(formatMoney(1234567890000n, 6, { grouping: false })).toBe('1234567.89');
  });

  it('formatBps formats a bps bigint as a percent', () => {
    expect(formatBps(50n)).toBe('0.50%');
    expect(formatBps(500n)).toBe('5.00%');
  });
});

describe('the number-typed-value guard', () => {
  // This is the specific test the phase-5 brief calls out: "Include a test that a
  // number-typed value never reaches a money formatter."
  it('formatMoney throws MoneyTypeError when given a JS number instead of a bigint/string', () => {
    // @ts-expect-error deliberately passing a number to prove the runtime guard fires
    // even when a caller bypasses the TypeScript types (e.g. from untyped JS, or a
    // future refactor that loosens a type).
    expect(() => formatMoney(65001.5, 18)).toThrow(MoneyTypeError);
  });

  it('parseHumanDecimal throws MoneyTypeError for a JS number', () => {
    // @ts-expect-error see above
    expect(() => parseHumanDecimal(999.5, 6)).toThrow(MoneyTypeError);
  });

  it('parseRawUnits throws MoneyTypeError for a JS number', () => {
    // @ts-expect-error see above
    expect(() => parseRawUnits(65001)).toThrow(MoneyTypeError);
  });

  it('formatLeverage throws MoneyTypeError for a JS number', () => {
    // @ts-expect-error see above
    expect(() => formatLeverage(1000)).toThrow(MoneyTypeError);
  });

  it('does not accidentally reject a numeric-looking string', () => {
    expect(() => formatMoney('65001', 18)).not.toThrow();
  });
});

describe('parseHumanDecimal (user-typed input)', () => {
  it('parses a typed collateral amount into exact 6-decimal units', () => {
    expect(parseHumanDecimal('999', 6)).toBe(999000000n);
    expect(parseHumanDecimal('999.00', 6)).toBe(999000000n);
    expect(parseHumanDecimal('0.5', 6)).toBe(500000n);
  });

  it('truncates (never rounds) extra fractional digits beyond `decimals`', () => {
    // 0.1234567 typed against a 6-decimal field must truncate to 0.123456, not round up
    // to 0.123457 — rounding up would silently take more collateral than the user typed.
    expect(parseHumanDecimal('0.1234567', 6)).toBe(123456n);
  });

  it('parses a negative amount', () => {
    expect(parseHumanDecimal('-5.5', 6)).toBe(-5500000n);
  });

  it('rejects garbage input', () => {
    expect(() => parseHumanDecimal('not-a-number', 6)).toThrow();
    expect(() => parseHumanDecimal('', 6)).toThrow();
  });
});

describe('parseRawUnits (raw integer-string ingestion)', () => {
  it('parses the exact raw integer string from the deployment file', () => {
    // The digits of the same two proofTrade values, as the JSON artifact stores them.
    expect(parseRawUnits('65001000000000000000000')).toBe(65001000000000000000000n);
    expect(parseRawUnits('999000000')).toBe(999000000n);
  });

  it('rejects a string containing a decimal point (that is parseHumanDecimal territory)', () => {
    expect(() => parseRawUnits('65001.00')).toThrow();
  });

  it('passes a bigint through unchanged', () => {
    expect(parseRawUnits(42n)).toBe(42n);
  });
});

describe('round-trip exactness', () => {
  it('parseHumanDecimal -> formatExact round-trips without precision loss', () => {
    const raw = parseHumanDecimal('12345.678901', 6);
    expect(formatExact(raw, 6)).toBe('12345.678901');
  });
});

describe('formatCompactMoney', () => {
  // Raw 6-decimal collateral, the scale /markets and the candle volume field use.
  it('abbreviates millions, thousands and billions without touching a float', () => {
    expect(formatCompactMoney(38_200_000_000000n, 6)).toBe('38.2M');
    expect(formatCompactMoney(1_400_000000n, 6)).toBe('1.4K');
    expect(formatCompactMoney(2_500_000_000_000000n, 6)).toBe('2.5B');
  });

  it('leaves anything under a thousand in full, grouped form', () => {
    expect(formatCompactMoney(999_000000n, 6)).toBe('999.00');
    expect(formatCompactMoney(0n, 6)).toBe('0.00');
  });

  it('keeps the sign', () => {
    expect(formatCompactMoney(-38_200_000_000000n, 6)).toBe('-38.2M');
  });

  it('accepts the API human-decimal string form too, at the same scale', () => {
    expect(formatCompactMoney('38200000.000000', 6)).toBe('38.2M');
  });

  it('rejects a JS number like every other money function here', () => {
    // @ts-expect-error deliberately passing the one type this module refuses
    expect(() => formatCompactMoney(38_200_000, 6)).toThrow();
  });
});
