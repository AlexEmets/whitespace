import { describe, expect, it } from 'vitest';
import { fundingRatePerHourP, marginUsagePercent, netFundingForDisplay, valueAt } from '@/lib/positionMath';

const E18 = 10n ** 18n;

describe('marginUsagePercent', () => {
  const long = { buy: true, entry: 100n * E18, liq: 90n * E18 };
  it('is 0 at entry and in profit, 100 at and past liquidation', () => {
    expect(marginUsagePercent({ ...long, mark: 100n * E18 })).toBe(0);
    expect(marginUsagePercent({ ...long, mark: 110n * E18 })).toBe(0);
    expect(marginUsagePercent({ ...long, mark: 90n * E18 })).toBe(100);
    expect(marginUsagePercent({ ...long, mark: 80n * E18 })).toBe(100);
  });
  it('is linear in between, to two decimals', () => {
    expect(marginUsagePercent({ ...long, mark: 95n * E18 })).toBe(50);
    expect(marginUsagePercent({ ...long, mark: 97n * E18 })).toBe(30);
  });
  it('mirrors for a short', () => {
    const short = { buy: false, entry: 100n * E18, liq: 110n * E18 };
    expect(marginUsagePercent({ ...short, mark: 105n * E18 })).toBe(50);
    expect(marginUsagePercent({ ...short, mark: 95n * E18 })).toBe(0);
  });
  it('is 0 when the liquidation price is unusable', () => {
    expect(marginUsagePercent({ ...long, liq: 100n * E18, mark: 50n * E18 })).toBe(0);
  });
});

describe('valueAt', () => {
  it('0.1 BTC at 65,001 is 6,500.10 USDW', () => {
    expect(valueAt(E18 / 10n, 65_001n * E18)).toBe(6_500_100_000n);
  });
});

describe('netFundingForDisplay', () => {
  it('shows costs negative and receipts positive', () => {
    expect(netFundingForDisplay(2_000_000n, 500_000n)).toBe(-2_500_000n);
    expect(netFundingForDisplay(-3_000_000n, 500_000n)).toBe(2_500_000n);
  });
});

describe('fundingRatePerHourP', () => {
  it('scales a per-block fraction to percent per hour at 1 s blocks', () => {
    // 100%/year cap: 31,709,791,983 per block → 0.0114155% per hour
    expect(fundingRatePerHourP(31_709_791_983n)).toBe(11_415_525_113_880_000n);
    expect(fundingRatePerHourP(-1n)).toBe(-360_000n);
  });
});
