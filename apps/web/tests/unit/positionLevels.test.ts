import { describe, expect, it } from 'vitest';
import { levelsInView, positionLevels } from '@/lib/positionLevels';
import type { PositionSummary } from '@/lib/types';

const E18 = 10n ** 18n;

const position = (overrides: Partial<PositionSummary> = {}): PositionSummary => ({
  pairIndex: 0,
  index: 1,
  buy: true,
  collateral: '775.900000',
  leverage: '100.00',
  openPrice: '77985.270000000000000000',
  tp: '85003.940000000000000000',
  sl: '0',
  openedAt: 1_790_000_000,
  tradeId: '7',
  ...overrides,
});

const LIQ = 77_406_870000000000000000n; // 77,406.87

describe('positionLevels', () => {
  it('puts the entry, the take-profit and the liquidation on the chart, and leaves an unset stop-loss off', () => {
    const levels = positionLevels(position(), LIQ);
    expect(levels.map((l) => l.kind)).toEqual(['entry', 'tp', 'liq']);
    expect(levels.map((l) => l.price)).toEqual([77_985_270000000000000000n, 85_003_940000000000000000n, LIQ]);
    expect(levels.map((l) => l.tag)).toEqual(['Long 100.00x', 'TP', 'Liq.']);
  });

  it('labels a short as a short, and draws its stop-loss once one is set', () => {
    const levels = positionLevels(position({ buy: false, leverage: '25.00', tp: '0', sl: '80000.000000000000000000' }), LIQ);
    expect(levels.map((l) => l.kind)).toEqual(['entry', 'sl', 'liq']);
    expect(levels[0]!.tag).toBe('Short 25.00x');
    expect(levels[1]!.price).toBe(80_000n * E18);
  });

  it('leaves the liquidation off until the contract has answered', () => {
    expect(positionLevels(position(), null).map((l) => l.kind)).toEqual(['entry', 'tp']);
  });

  it('keys every level by its position, so two positions on one market never collide', () => {
    const keys = [...positionLevels(position({ index: 1 }), LIQ), ...positionLevels(position({ index: 2 }), LIQ)].map((l) => l.key);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
  });
});

describe('levelsInView', () => {
  it('keeps the levels inside the visible price range, edges included, and drops the rest', () => {
    const levels = positionLevels(position(), LIQ); // 77,985.27 · 85,003.94 · 77,406.87
    const inView = levelsInView(levels, 77_406_870000000000000000n, 80_000n * E18);
    expect(inView.map((l) => l.kind)).toEqual(['entry', 'liq']);
  });
});
