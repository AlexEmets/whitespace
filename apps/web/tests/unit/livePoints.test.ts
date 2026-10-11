import { describe, it, expect } from 'vitest';
import {
  liveDecimals,
  pendingLpPointsRaw,
  pendingTimePointsRaw,
  ratePerSecond,
  timePointsPerDayRaw,
  timeWarmup,
} from '@/lib/livePoints';
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

describe('liveDecimals', () => {
  it('shows enough places for 100 USDW in the pool to move, capped at the ledger’s six', () => {
    // 0.1 pt a day: at three places it changed once every 2.4 hours.
    expect(liveDecimals(0.1 / 86_400, 3)).toBe(6);
  });

  it('picks the place whose digit turns over about ten times a second', () => {
    // 12,400 notional held: 29.76 pts a day, 0.000344 a second.
    expect(liveDecimals(29.76 / 86_400, 3)).toBe(5);
    expect(liveDecimals(0.5, 0)).toBe(2);
  });

  it('never goes under the floor it is given, however fast the counter runs', () => {
    expect(liveDecimals(1000, 3)).toBe(3);
  });

  it('keeps the floor when nothing is accruing or the rate is not a number', () => {
    expect(liveDecimals(0, 3)).toBe(3);
    expect(liveDecimals(-1, 2)).toBe(2);
    expect(liveDecimals(Number.NaN, 3)).toBe(3);
    expect(liveDecimals(Number.POSITIVE_INFINITY, 3)).toBe(3);
  });

  it('honours a lower ceiling', () => {
    expect(liveDecimals(1e-9, 2, 4)).toBe(4);
  });
});

describe('ratePerSecond', () => {
  it('turns raw points a day into points a second', () => {
    expect(ratePerSecond(86_400_000_000n)).toBe(1);
    expect(ratePerSecond(0n)).toBe(0);
  });
});

describe('timePointsPerDayRaw', () => {
  it('is the pace of positions past the floor: 12,400 notional earns 29.76 a day', () => {
    expect(timePointsPerDayRaw([position({ openedAt: 1000 })], 1000 + 300)).toBe(29_760_000n);
  });

  it('leaves out a position still under the floor', () => {
    const positions = [position({ openedAt: 1000 }), position({ openedAt: 1200, index: 1 })];
    expect(timePointsPerDayRaw(positions, 1000 + 400)).toBe(29_760_000n);
    expect(timePointsPerDayRaw([position({ openedAt: 1000 })], 1000 + 299)).toBe(0n);
  });

  it('applies the per-position notional cap', () => {
    // 10,000 x 100 = 1,000,000 notional, capped at 50,000: 120 a day.
    expect(timePointsPerDayRaw([position({ collateral: '10000.000000', leverage: '100.00', openedAt: 0 })], 600)).toBe(120_000_000n);
  });
});

describe('timeWarmup', () => {
  it('is null when nothing is waiting', () => {
    expect(timeWarmup([], 1000)).toBeNull();
    expect(timeWarmup([position({ openedAt: 0 })], 300)).toBeNull();
  });

  it('counts down to the first waiting position to cross, and how far through it is', () => {
    const positions = [position({ openedAt: 1000 }), position({ openedAt: 1100, index: 1 }), position({ openedAt: 0, index: 2 })];
    expect(timeWarmup(positions, 1060)).toEqual({ secondsLeft: 240, progress: 0.2, waiting: 2 });
  });

  it('treats a clock behind the open time as a wait just started', () => {
    expect(timeWarmup([position({ openedAt: 1000 })], 990)).toEqual({ secondsLeft: 300, progress: 0, waiting: 1 });
  });
});
