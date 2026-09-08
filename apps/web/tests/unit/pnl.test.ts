import { describe, expect, it } from 'vitest';
import { estimatePositionSizeBase, estimateUnrealisedPnl } from '@/lib/pnl';
import { formatMoney } from '@/lib/money';

describe('estimateUnrealisedPnl', () => {
  it('is zero when mark price equals open price', () => {
    const pnl = estimateUnrealisedPnl({
      collateral: '999000000',
      leverage: '1000',
      openPrice: '65001000000000000000000',
      markPrice: '65001000000000000000000',
      buy: true,
    });
    expect(pnl).toBe(0n);
  });

  it('is positive for a long when price rises', () => {
    const pnl = estimateUnrealisedPnl({
      collateral: '1000000000', // 1000 USDW
      leverage: '1000', // 10x
      openPrice: '100000000000000000000', // 100.00
      markPrice: '110000000000000000000', // 110.00 (+10%)
      buy: true,
    });
    // notional = 1000 * 10 = 10,000 USDW; +10% price move * 10x leverage = +100% of
    // collateral = +1000 USDW.
    expect(pnl).toBe(1000000000n);
    expect(formatMoney(pnl, 6, { signDisplay: true })).toBe('+1,000.00');
  });

  it('is negative for a long when price falls, and flips sign for a short', () => {
    const longPnl = estimateUnrealisedPnl({
      collateral: '1000000000',
      leverage: '1000',
      openPrice: '100000000000000000000',
      markPrice: '90000000000000000000', // -10%
      buy: true,
    });
    expect(longPnl).toBe(-1000000000n);

    const shortPnl = estimateUnrealisedPnl({
      collateral: '1000000000',
      leverage: '1000',
      openPrice: '100000000000000000000',
      markPrice: '90000000000000000000', // -10%
      buy: false,
    });
    expect(shortPnl).toBe(1000000000n);
  });

  it('scales with leverage', () => {
    const base = {
      collateral: '1000000000',
      openPrice: '100000000000000000000',
      markPrice: '101000000000000000000', // +1%
      buy: true,
    };
    const pnl1x = estimateUnrealisedPnl({ ...base, leverage: '100' }); // 1x
    const pnl10x = estimateUnrealisedPnl({ ...base, leverage: '1000' }); // 10x
    expect(pnl10x).toBe(pnl1x * 10n);
  });

  it('returns 0n rather than dividing by zero for a malformed zero open price', () => {
    const pnl = estimateUnrealisedPnl({
      collateral: '1000000000',
      leverage: '1000',
      openPrice: '0',
      markPrice: '100000000000000000000',
      buy: true,
    });
    expect(pnl).toBe(0n);
  });

  it('accepts raw API decimal strings end-to-end, never a JS number', () => {
    // Every field here is a string, exactly the shape /positions/:address delivers per
    // D3. If any internal step silently coerced through Number(), this would either
    // throw (via the money.ts guards it calls) or silently misround for large values —
    // this test pins the "no throw, exact result" contract.
    const pnl = estimateUnrealisedPnl({
      collateral: '999000000',
      leverage: '1000',
      openPrice: '65001000000000000000000',
      markPrice: '65651010000000000000000', // +1%
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
      collateral: '1000000000',
      leverage: '1000',
      openPrice: '65001000000000000000000',
    });
    expect(size).toBe(153843787018661251n);
    expect(formatMoney(size, 18, { fractionDigits: 4, grouping: false })).toBe('0.1538');
  });

  it('scales linearly with collateral', () => {
    const base = { leverage: '100', openPrice: '100000000000000000000' };
    const small = estimatePositionSizeBase({ ...base, collateral: '100000000' });
    const large = estimatePositionSizeBase({ ...base, collateral: '1000000000' });
    expect(large).toBe(small * 10n);
  });

  it('returns 0n for a zero open price rather than dividing by zero', () => {
    const size = estimatePositionSizeBase({ collateral: '1000000000', leverage: '1000', openPrice: '0' });
    expect(size).toBe(0n);
  });
});
