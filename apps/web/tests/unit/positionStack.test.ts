import { describe, expect, it } from 'vitest';
import { nearestLiquidation, stackPositions } from '@/lib/positionStack';
import type { PositionSummary } from '@/lib/types';

const pos = (over: Partial<PositionSummary>): PositionSummary => ({
  pairIndex: 0,
  index: 0,
  buy: true,
  collateral: '1000.000000',
  leverage: '10.00',
  openPrice: '100.000000000000000000',
  tp: '0',
  sl: '0',
  openedAt: 100,
  tradeId: '1',
  ...over,
});

// 1,000 USDW at 10x from 100 (size 100) and 500 USDW at 20x from 125 (size 80).
const a = pos({ index: 0, tradeId: '1', openedAt: 100 });
const b = pos({ index: 1, tradeId: '2', openedAt: 200, collateral: '500.000000', leverage: '20.00', openPrice: '125.000000000000000000' });

describe('stackPositions', () => {
  it('passes a lone trade through untouched', () => {
    const [s] = stackPositions([a]);
    expect(s!.legs).toEqual([a]);
    expect(s!.summary).toBe(a);
    expect(s!.sizeBaseRaw).toBe(100n * 10n ** 18n);
    expect(s!.key).toBe('0-long');
  });

  it('combines two longs on one market into one position', () => {
    const stacks = stackPositions([a, b]);
    expect(stacks).toHaveLength(1);
    const s = stacks[0]!;
    expect(s.legs.map((l) => l.index)).toEqual([0, 1]);
    expect(s.summary.collateral).toBe('1500');
    // Total notional 20,000 over total margin 1,500, floored at PRECISION_2.
    expect(s.summary.leverage).toBe('13.33');
    // Size-weighted: 20,000 notional over 180 units, not the plain mean of 100 and 125.
    expect(s.summary.openPrice).toBe('111.111111111111111111');
    expect(s.sizeBaseRaw).toBe(180n * 10n ** 18n);
  });

  it('keeps longs and shorts, and different markets, apart', () => {
    const short = pos({ index: 2, buy: false });
    const eth = pos({ index: 0, pairIndex: 1 });
    const stacks = stackPositions([a, short, eth, b]);
    expect(stacks.map((s) => s.key)).toEqual(['0-long', '0-short', '1-long']);
    expect(stacks[0]!.legs).toHaveLength(2);
  });

  it('orders a stack’s trades oldest first whatever order they arrive in', () => {
    expect(stackPositions([b, a])[0]!.legs.map((l) => l.index)).toEqual([0, 1]);
  });

  it('shows a TP or SL the trades share, and marks one they do not', () => {
    const same = stackPositions([pos({ index: 0, tp: '150', sl: '90' }), pos({ index: 1, tp: '150.0', sl: '80' })])[0]!;
    expect(same.summary.tp).toBe('150');
    expect(same.tpMixed).toBe(false);
    expect(same.summary.sl).toBe('0');
    expect(same.slMixed).toBe(true);
  });
});

describe('nearestLiquidation', () => {
  it('is the highest level for a long and the lowest for a short', () => {
    expect(nearestLiquidation(true, [90n, 112n, 100n])).toBe(112n);
    expect(nearestLiquidation(false, [190n, 140n, 150n])).toBe(140n);
  });

  it('is unknown while any level is, or when there are none', () => {
    expect(nearestLiquidation(true, [90n, null])).toBeNull();
    expect(nearestLiquidation(true, [])).toBeNull();
  });
});
