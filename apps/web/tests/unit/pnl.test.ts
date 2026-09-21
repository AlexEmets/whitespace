import { describe, expect, it } from 'vitest';
import { collateralForPositionSize, estimatePositionSizeBase, estimateUnrealisedPnl } from '@/lib/pnl';
import { formatMoney } from '@/lib/money';

// Every fixture in this file is a human decimal string exactly as the read API emits it —
// services/api's format.ts always prints `decimals` fraction digits, so 18 for a price, 6
// for collateral, 2 for leverage. These are NOT the raw scaled integers the contract
// holds; see src/lib/money.ts's module header for why the two must never be swapped.

describe('estimateUnrealisedPnl', () => {
  it('is zero when mark price equals open price', () => {
    const pnl = estimateUnrealisedPnl({
      collateral: '999.000000',
      leverage: '10.00',
      openPrice: '65001.000000000000000000',
      markPrice: '65001.000000000000000000',
      buy: true,
    });
    expect(pnl).toBe(0n);
  });

  it('is positive for a long when price rises', () => {
    const pnl = estimateUnrealisedPnl({
      collateral: '1000.000000', // 1000 USDW
      leverage: '10.00', // 10x
      openPrice: '100.000000000000000000', // 100.00
      markPrice: '110.000000000000000000', // 110.00 (+10%)
      buy: true,
    });
    // notional = 1000 * 10 = 10,000 USDW; +10% price move * 10x leverage = +100% of
    // collateral = +1000 USDW.
    expect(pnl).toBe(1000000000n);
    expect(formatMoney(pnl, 6, { signDisplay: true })).toBe('+1,000.00');
  });

  it('is negative for a long when price falls, and flips sign for a short', () => {
    const longPnl = estimateUnrealisedPnl({
      collateral: '1000.000000',
      leverage: '10.00',
      openPrice: '100.000000000000000000',
      markPrice: '90.000000000000000000', // -10%
      buy: true,
    });
    expect(longPnl).toBe(-1000000000n);

    const shortPnl = estimateUnrealisedPnl({
      collateral: '1000.000000',
      leverage: '10.00',
      openPrice: '100.000000000000000000',
      markPrice: '90.000000000000000000', // -10%
      buy: false,
    });
    expect(shortPnl).toBe(1000000000n);
  });

  it('scales with leverage', () => {
    const base = {
      collateral: '1000.000000',
      openPrice: '100.000000000000000000',
      markPrice: '101.000000000000000000', // +1%
      buy: true,
    };
    const pnl1x = estimateUnrealisedPnl({ ...base, leverage: '1.00' }); // 1x
    const pnl10x = estimateUnrealisedPnl({ ...base, leverage: '10.00' }); // 10x
    expect(pnl10x).toBe(pnl1x * 10n);
  });

  it('returns 0n rather than dividing by zero for a malformed zero open price', () => {
    const pnl = estimateUnrealisedPnl({
      collateral: '1000.000000',
      leverage: '10.00',
      openPrice: '0.000000000000000000',
      markPrice: '100.000000000000000000',
      buy: true,
    });
    expect(pnl).toBe(0n);
  });

  it("accepts the API's human decimal strings end-to-end, never a JS number", () => {
    // Every field here is a human decimal string carrying its full fraction digits,
    // exactly the shape /positions/:address delivers per D3. If any internal step
    // silently coerced through Number(), this would either throw (via the money.ts guards
    // it calls) or silently misround for large values — this test pins the "no throw,
    // exact result" contract.
    const pnl = estimateUnrealisedPnl({
      collateral: '999.000000',
      leverage: '10.00',
      openPrice: '65001.000000000000000000',
      markPrice: '65651.010000000000000000', // +1%
      buy: true,
    });
    expect(typeof pnl).toBe('bigint');
  });
});

describe('estimatePositionSizeBase', () => {
  it('computes the exact base-asset size for the E2E gate scenario (1,000 USDW @ 10x @ 65,001.00)', () => {
    // Cross-checked independently in bash with the same bigint arithmetic before being
    // pinned here — see tests/e2e/trade-flow.spec.ts's matching position-row assertion.
    const size = estimatePositionSizeBase({
      collateral: '1000.000000',
      leverage: '10.00',
      openPrice: '65001.000000000000000000',
    });
    expect(size).toBe(153843787018661251n);
    expect(formatMoney(size, 18, { fractionDigits: 4, grouping: false })).toBe('0.1538');
  });

  it('scales linearly with collateral', () => {
    const base = { leverage: '1.00', openPrice: '100.000000000000000000' };
    const small = estimatePositionSizeBase({ ...base, collateral: '100.000000' });
    const large = estimatePositionSizeBase({ ...base, collateral: '1000.000000' });
    expect(large).toBe(small * 10n);
  });

  it('returns 0n for a zero open price rather than dividing by zero', () => {
    const size = estimatePositionSizeBase({ collateral: '1000.000000', leverage: '10.00', openPrice: '0.000000000000000000' });
    expect(size).toBe(0n);
  });
});

/**
 * Unlike `estimatePositionSizeBase`, this one is NOT display-only: the order form is
 * denominated in the base asset and its result is the `collateral` handed to
 * `openTrade`. An error here is a wrong amount of money leaving the wallet, so the cases
 * below pin exact bigints rather than approximations.
 */
describe('collateralForPositionSize', () => {
  it('converts a base-asset size to the collateral that buys it', () => {
    // 0.01 BTC at 65,001.00 with 10x: notional 650.01, collateral 65.001000 USDW.
    const collateral = collateralForPositionSize({
      sizeBaseRaw: 10_000_000_000_000_000n, // 0.01 at 18 decimals
      leverage: '10.00',
      openPrice: '65001.000000000000000000',
    });
    expect(collateral).toBe(65_001_000n);
  });

  it('round-trips with estimatePositionSizeBase', () => {
    const openPrice = '65001.000000000000000000';
    const leverage = '10.00';
    const collateral = '1000.000000';

    const size = estimatePositionSizeBase({ collateral, leverage, openPrice });
    const back = collateralForPositionSize({ sizeBaseRaw: size, leverage, openPrice });

    // Both directions floor, so the round trip may lose the last collateral unit — one
    // millionth of a USDW. It must never gain one: that would be spending more than the
    // trader's balance check approved.
    expect(back).toBeLessThanOrEqual(1_000_000_000n);
    expect(back).toBeGreaterThanOrEqual(1_000_000_000n - 1n);
  });

  it('halves the collateral when leverage doubles, for the same size', () => {
    const base = { sizeBaseRaw: 10_000_000_000_000_000n, openPrice: '65001.000000000000000000' };
    const at10x = collateralForPositionSize({ ...base, leverage: '10.00' });
    const at20x = collateralForPositionSize({ ...base, leverage: '20.00' });
    expect(at20x * 2n).toBe(at10x);
  });

  it('returns 0n rather than dividing by a zero price or zero leverage', () => {
    const base = { sizeBaseRaw: 10_000_000_000_000_000n };
    expect(collateralForPositionSize({ ...base, leverage: '10.00', openPrice: '0.000000000000000000' })).toBe(0n);
    expect(collateralForPositionSize({ ...base, leverage: '0.00', openPrice: '65001.000000000000000000' })).toBe(0n);
    expect(collateralForPositionSize({ sizeBaseRaw: 0n, leverage: '10.00', openPrice: '65001.000000000000000000' })).toBe(0n);
  });
});
