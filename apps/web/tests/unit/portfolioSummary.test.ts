import { describe, expect, it } from 'vitest';
import type { ClosedTrade } from '@/lib/closedTrade';
import { accountShares, cumulativeRealisedPnl, tradePerformance, winRate } from '@/lib/portfolio';

function trade(overrides: Partial<ClosedTrade>): ClosedTrade {
  return {
    pairIndex: 0,
    index: 0,
    buy: true,
    collateral: '100.000000',
    leverage: '10.00',
    openPrice: '80000.000000000000000000',
    closePrice: '80100.000000000000000000',
    openedAt: 1_000,
    closedAt: 1_060,
    tradeId: '1',
    rowKey: '1',
    isPartial: false,
    percentageClosed: '100.00',
    closeReason: null,
    realisedPnlRaw: 0n,
    notionalRaw: 1_000_000_000n,
    ...overrides,
  };
}

describe('accountShares', () => {
  it('splits the bar in proportion to each part', () => {
    const shares = accountShares({ wallet: 600_000000n, margin: 200_000000n, unrealised: 100_000000n, lp: 100_000000n });
    expect(shares).toEqual({ wallet: 0.6, margin: 0.2, unrealised: 0.1, lp: 0.1 });
  });

  it('draws a losing unrealised PnL as no slice, and lets the rest fill the bar', () => {
    const shares = accountShares({ wallet: 300_000000n, margin: 100_000000n, unrealised: -50_000000n, lp: 0n });
    expect(shares).toEqual({ wallet: 0.75, margin: 0.25, unrealised: 0, lp: 0 });
  });

  it('is null when any part is unknown, the same rule as the total', () => {
    expect(accountShares({ wallet: 1n, margin: 1n, unrealised: null, lp: 1n })).toBeNull();
    expect(accountShares({ wallet: null, margin: 1n, unrealised: 1n, lp: 1n })).toBeNull();
  });

  it('draws nothing for an empty account instead of dividing by zero', () => {
    expect(accountShares({ wallet: 0n, margin: 0n, unrealised: 0n, lp: 0n })).toEqual({
      wallet: 0,
      margin: 0,
      unrealised: 0,
      lp: 0,
    });
  });

  it('keeps a sliver of a large account visible to the micro-unit', () => {
    const shares = accountShares({ wallet: 19_884_790000n, margin: 98_400000n, unrealised: 4_460000n, lp: 0n })!;
    expect(shares.margin).toBeCloseTo(0.004923, 6);
    expect(shares.wallet + shares.margin + shares.unrealised + shares.lp).toBeCloseTo(1, 5);
  });
});

describe('winRate', () => {
  it('is wins over decided closes', () => {
    expect(winRate(4, 4)).toBe(0.5);
    expect(winRate(3, 1)).toBe(0.75);
  });

  it('is null before anything has won or lost', () => {
    expect(winRate(0, 0)).toBeNull();
  });
});

describe('tradePerformance', () => {
  it('averages the holding time and finds the best and worst close', () => {
    const perf = tradePerformance([
      trade({ rowKey: '1', openedAt: 0, closedAt: 12, realisedPnlRaw: 280_000n }),
      trade({ rowKey: '2', openedAt: 0, closedAt: 24, realisedPnlRaw: -50_000n }),
      trade({ rowKey: '3', openedAt: 0, closedAt: 18, realisedPnlRaw: 30_000n }),
    ]);
    expect(perf).toEqual({ avgHoldSeconds: 18, bestRaw: 280_000n, worstRaw: -50_000n });
  });

  it('leaves a close without a timestamp out of the average rather than counting it as zero', () => {
    const perf = tradePerformance([
      trade({ rowKey: '1', openedAt: 0, closedAt: 30 }),
      trade({ rowKey: '2', openedAt: 0, closedAt: null }),
    ]);
    expect(perf.avgHoldSeconds).toBe(30);
  });

  it('leaves a close without its PnL out of best and worst', () => {
    const perf = tradePerformance([trade({ rowKey: '1', realisedPnlRaw: null }), trade({ rowKey: '2', realisedPnlRaw: -1n })]);
    expect(perf.bestRaw).toBe(-1n);
    expect(perf.worstRaw).toBe(-1n);
  });

  it('has nothing to report for an account with no closes', () => {
    expect(tradePerformance([])).toEqual({ avgHoldSeconds: null, bestRaw: null, worstRaw: null });
  });
});

describe('cumulativeRealisedPnl', () => {
  it('runs from zero through each close, oldest first, whatever order the API sent', () => {
    // The API sends newest first.
    const series = cumulativeRealisedPnl([
      trade({ rowKey: '3', closedAt: 300, realisedPnlRaw: -20_000n }),
      trade({ rowKey: '2', closedAt: 200, realisedPnlRaw: 280_000n }),
      trade({ rowKey: '1', closedAt: 100, realisedPnlRaw: -50_000n }),
    ]);
    expect(series).toEqual([0n, -50_000n, 230_000n, 210_000n]);
  });

  it('orders closes in the same second by their close order', () => {
    const series = cumulativeRealisedPnl([
      trade({ rowKey: '11', closedAt: 100, realisedPnlRaw: 5n }),
      trade({ rowKey: '9', closedAt: 100, realisedPnlRaw: -3n }),
    ]);
    expect(series).toEqual([0n, -3n, 2n]);
  });

  it('still orders closes whose key is not a close order id, instead of throwing', () => {
    const series = cumulativeRealisedPnl([
      trade({ rowKey: '7-0-1', closedAt: 100, realisedPnlRaw: 5n }),
      trade({ rowKey: '7-0-0', closedAt: 100, realisedPnlRaw: -3n }),
    ]);
    expect(series).toEqual([0n, -3n, 2n]);
  });

  it('ends at the realised total', () => {
    const trades = [trade({ rowKey: '1', realisedPnlRaw: 7n }), trade({ rowKey: '2', realisedPnlRaw: -2n })];
    expect(cumulativeRealisedPnl(trades)!.at(-1)).toBe(5n);
  });

  it('is null when a close is missing its PnL, since the curve would end on the wrong total', () => {
    expect(cumulativeRealisedPnl([trade({ rowKey: '1', realisedPnlRaw: null })])).toBeNull();
  });

  it('is empty before the first close', () => {
    expect(cumulativeRealisedPnl([])).toEqual([]);
  });
});
