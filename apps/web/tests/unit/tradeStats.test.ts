import { describe, expect, it } from 'vitest';
import {
  groupByMarket,
  lockedCollateralRaw,
  notionalRaw,
  openNotionalRaw,
  summariseClosedTrades,
  toClosedTrade,
} from '@/hooks/useTradeStats';
import type { ClosedPositionSummary, PositionSummary } from '@/lib/types';

/**
 * The arithmetic behind /portfolio's realised-PnL tile and every figure on /points.
 *
 * Two things are being pinned here. First, that the numbers are exact bigint arithmetic on
 * the API's human-decimal strings — no floats anywhere. Second, and more important, that a
 * missing input produces `null` rather than a plausible wrong total: a realised-PnL figure
 * summed over only the rows that happened to carry a payout is not the trader's realised
 * PnL, and shipping it as one would be the exact failure mode this app exists to avoid.
 */

/** A history row exactly as `GET /positions/:address/history` emits it — the shape was
 * copied from a live curl against the running API, not from src/lib/types.ts (which
 * declares a `realisedPnl` field the API does not send; see the note in useTradeStats). */
function wireRow(overrides: Record<string, unknown> = {}): ClosedPositionSummary {
  return {
    pairIndex: 0,
    index: 0,
    buy: true,
    collateral: '999.000000',
    leverage: '10.00',
    openPrice: '65001.000000000000000000',
    closePrice: '64999.000000000000000000',
    tp: '123501.900000000000000000',
    sl: '0.000000000000000000',
    tradeId: '2',
    openedAt: 1788881084,
    closedAt: 1788881094,
    closeReason: 'close',
    percentProfit: '-0.000000000000030768',
    usdcSentToTrader: '998.692628',
    realizedPnl: '-0.307372',
    ...overrides,
  } as unknown as ClosedPositionSummary;
}

describe('toClosedTrade', () => {
  it('reads the API\'s American-spelled realizedPnl, which src/lib/types.ts does not declare', () => {
    const trade = toClosedTrade(wireRow());
    // -0.307372 USDW at 6 decimals.
    expect(trade.realisedPnlRaw).toBe(-307372n);
    expect(trade.closeReason).toBe('close');
    expect(trade.closePrice).toBe('64999.000000000000000000');
  });

  it('accepts the British spelling too, so a rename in either direction cannot blank the column', () => {
    const trade = toClosedTrade(wireRow({ realizedPnl: undefined, realisedPnl: '-0.307372' }));
    expect(trade.realisedPnlRaw).toBe(-307372n);
  });

  it('falls back to the payout definition (usdcSentToTrader - collateral) when no PnL field is present', () => {
    const trade = toClosedTrade(wireRow({ realizedPnl: undefined, realisedPnl: undefined }));
    // 998.692628 - 999.000000, exactly as services/api/src/routes/positions.ts:69 derives it.
    expect(trade.realisedPnlRaw).toBe(998692628n - 999000000n);
  });

  it('reports null — never zero — when the wire carried nothing to derive PnL from', () => {
    const trade = toClosedTrade(wireRow({ realizedPnl: undefined, realisedPnl: undefined, usdcSentToTrader: undefined }));
    expect(trade.realisedPnlRaw).toBeNull();
  });

  it('computes opening notional as collateral x leverage in 6-decimal units', () => {
    // 999.00 x 10.00 = 9,990.00
    expect(toClosedTrade(wireRow()).notionalRaw).toBe(9_990_000000n);
  });
});

describe('notionalRaw', () => {
  it('cancels leverage\'s two implied decimals exactly', () => {
    expect(notionalRaw('100.000000', '10.00')).toBe(1_000_000000n);
    expect(notionalRaw('33.333333', '3.00')).toBe(99_999999n);
    // A fractional leverage must not round through a float.
    expect(notionalRaw('1.000000', '1.01')).toBe(1_010000n);
  });
});

describe('summariseClosedTrades', () => {
  it('sums realised PnL and notional across trades', () => {
    const stats = summariseClosedTrades([
      toClosedTrade(wireRow({ realizedPnl: '10.000000', tradeId: '1' })),
      toClosedTrade(wireRow({ realizedPnl: '-4.500000', tradeId: '2' })),
    ]);
    expect(stats.realisedPnlRaw).toBe(5_500000n);
    expect(stats.closedNotionalRaw).toBe(19_980_000000n);
    expect(stats.closedCount).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
  });

  it('collapses the realised total to null if ANY row is missing its PnL', () => {
    const stats = summariseClosedTrades([
      toClosedTrade(wireRow({ realizedPnl: '10.000000', tradeId: '1' })),
      toClosedTrade(wireRow({ realizedPnl: undefined, usdcSentToTrader: undefined, tradeId: '2' })),
    ]);
    // 10.00 would be a real-looking number and a false one — the partial sum is refused.
    expect(stats.realisedPnlRaw).toBeNull();
    // Notional is unaffected: it needs only collateral and leverage, which are present.
    expect(stats.closedNotionalRaw).toBe(19_980_000000n);
  });

  it('reports a genuine zero for an address with no trades, not an unknown', () => {
    const stats = summariseClosedTrades([]);
    expect(stats.realisedPnlRaw).toBe(0n);
    expect(stats.closedCount).toBe(0);
    expect(stats.marketsTraded).toBe(0);
    expect(stats.firstClosedAt).toBeNull();
  });

  it('counts distinct markets and the close-time window', () => {
    const stats = summariseClosedTrades([
      toClosedTrade(wireRow({ pairIndex: 0, closedAt: 200, tradeId: '1' })),
      toClosedTrade(wireRow({ pairIndex: 1, closedAt: 100, tradeId: '2' })),
      toClosedTrade(wireRow({ pairIndex: 1, closedAt: 300, tradeId: '3' })),
    ]);
    expect(stats.marketsTraded).toBe(2);
    expect(stats.firstClosedAt).toBe(100);
    expect(stats.lastClosedAt).toBe(300);
  });
});

describe('groupByMarket', () => {
  it('splits volume and PnL per market, ordered by volume', () => {
    const rows = groupByMarket([
      toClosedTrade(wireRow({ pairIndex: 1, collateral: '10.000000', leverage: '2.00', realizedPnl: '1.000000', tradeId: '1' })),
      toClosedTrade(wireRow({ pairIndex: 0, collateral: '100.000000', leverage: '2.00', realizedPnl: '2.000000', tradeId: '2' })),
      toClosedTrade(wireRow({ pairIndex: 0, collateral: '100.000000', leverage: '2.00', realizedPnl: '-3.000000', tradeId: '3' })),
    ]);
    expect(rows.map((r) => r.pairIndex)).toEqual([0, 1]);
    expect(rows[0]).toMatchObject({ closedCount: 2, notionalRaw: 400_000000n, realisedPnlRaw: -1_000000n });
    expect(rows[1]).toMatchObject({ closedCount: 1, notionalRaw: 20_000000n, realisedPnlRaw: 1_000000n });
  });

  it('nulls a market\'s PnL if one of its trades is missing a payout', () => {
    const rows = groupByMarket([
      toClosedTrade(wireRow({ pairIndex: 0, realizedPnl: '2.000000', tradeId: '1' })),
      toClosedTrade(wireRow({ pairIndex: 0, realizedPnl: undefined, usdcSentToTrader: undefined, tradeId: '2' })),
    ]);
    expect(rows[0]?.realisedPnlRaw).toBeNull();
  });
});

describe('open-position aggregates', () => {
  const positions: PositionSummary[] = [
    { pairIndex: 0, index: 0, buy: true, collateral: '499.000000', leverage: '10.00', openPrice: '78634.010000000000000000', tp: '0', sl: '0', openedAt: 1, tradeId: '4' },
    { pairIndex: 0, index: 1, buy: true, collateral: '29.000000', leverage: '5.00', openPrice: '78297.500000000000000000', tp: '0', sl: '0', openedAt: 2, tradeId: '5' },
    { pairIndex: 0, index: 2, buy: false, collateral: '39.000000', leverage: '3.00', openPrice: '78272.500000000000000000', tp: '0', sl: '0', openedAt: 3, tradeId: '6' },
  ];

  it('sums locked collateral', () => {
    expect(lockedCollateralRaw(positions)).toBe(567_000000n);
  });

  it('sums open notional across both sides (exposure, not net direction)', () => {
    // 4,990 + 145 + 117 = 5,252.00
    expect(openNotionalRaw(positions)).toBe(5_252_000000n);
  });

  it('is zero for an address with nothing open', () => {
    expect(lockedCollateralRaw([])).toBe(0n);
    expect(openNotionalRaw([])).toBe(0n);
  });
});
