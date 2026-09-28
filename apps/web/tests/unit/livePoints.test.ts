import { describe, it, expect } from 'vitest';
import { pendingTimePointsRaw, pendingLpPointsRaw } from '@/lib/livePoints';
import type { PositionSummary } from '@/lib/types';

function position(over: Partial<PositionSummary>): PositionSummary {
  return {
    pairIndex: 0,
    index: 0,
    buy: true,
    collateral: '1240.000000',
    leverage: '10.00',
    openPrice: '60000.000000000000000000',
    tp: '0',
    sl: '0',
    openedAt: 1000,
    tradeId: '1',
    ...over,
  };
}

describe('pendingTimePointsRaw', () => {
  it('scores collateral x leverage x time on an open position (1,240 notional x 1h = 1.24)', () => {
    const pts = pendingTimePointsRaw([position({ collateral: '1240.000000', leverage: '10.00', openedAt: 1000 })], 1000 + 3600);
    expect(pts).toBe(1_240_000n); // 1.240000 at 6dp
  });

  it('sums across several open positions', () => {
    const positions = [
      position({ collateral: '1240.000000', leverage: '10.00', openedAt: 1000 }),
      position({ collateral: '1240.000000', leverage: '10.00', openedAt: 1000, index: 1 }),
    ];
    expect(pendingTimePointsRaw(positions, 1000 + 3600)).toBe(2_480_000n);
  });

  it('ignores a position open under the five-minute floor', () => {
    expect(pendingTimePointsRaw([position({ openedAt: 1000 })], 1000 + 299)).toBe(0n);
  });

  it('is zero with no open positions', () => {
    expect(pendingTimePointsRaw([], 999_999)).toBe(0n);
  });
});

describe('pendingLpPointsRaw', () => {
  it('scores usdw-days since the balance last accrued (8,500 for a day = 8.5)', () => {
    expect(pendingLpPointsRaw(8_500_000_000n, 1000, 1000 + 86_400)).toBe(8_500_000n);
  });

  it('is zero when there is no balance or no anchor', () => {
    expect(pendingLpPointsRaw(null, 1000, 100_000)).toBe(0n);
    expect(pendingLpPointsRaw(0n, 1000, 100_000)).toBe(0n);
    expect(pendingLpPointsRaw(8_500_000_000n, null, 100_000)).toBe(0n);
  });
});
