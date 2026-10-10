import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const E18 = 10n ** 18n;
const TRADER = '0x1111111111111111111111111111111111111111';

const state = vi.hoisted(() => ({
  counts: [] as { status: string; result?: unknown }[],
  /** getOpenTrade answers, keyed `${pair}-${index}`; a missing key is an empty slot. */
  trades: {} as Record<string, unknown>,
  failTrades: false,
  apiPositions: [] as unknown[],
}));

vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: 3 }), // maxTradesPerPair
  useReadContracts: ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) => {
    if (contracts.length === 0) return { data: undefined };
    const fn = contracts[0]!.functionName;
    if (fn === 'openTradesCount') return { data: state.counts };
    if (fn === 'getOpenTrade') {
      return {
        data: contracts.map((c) => {
          if (state.failTrades) return { status: 'failure', error: new Error('rpc') };
          const key = `${c.args[1]}-${c.args[2]}`;
          return { status: 'success', result: state.trades[key] ?? { leverage: 0 } };
        }),
      };
    }
    if (fn === 'getOpenTradeInfo') {
      return { data: contracts.map((c) => ({ status: 'success', result: { tradeId: BigInt(100 + Number(c.args[2])), createdAt: 1_790_000_000 } })) };
    }
    return { data: undefined };
  },
}));

vi.mock('@/hooks/useLiveResource', () => ({
  useLiveResource: () => ({ data: state.apiPositions, error: null, stale: false, loading: false, refetch: vi.fn() }),
}));

import { usePositions } from '@/hooks/usePositions';

const trade = (index: number) => ({
  collateral: 1_000_000000n,
  openPrice: 65_000n * E18,
  tp: 0n,
  sl: 60_000n * E18,
  trader: TRADER,
  leverage: 1000,
  pairIndex: 0,
  index,
  buy: true,
  isDayTrade: false,
});

const apiStalePosition = {
  pairIndex: 0, index: 0, buy: true, collateral: '1000.000000', leverage: '10.00', openPrice: '65000', tp: '0', sl: '0', openedAt: 1, tradeId: '31',
};

beforeEach(() => {
  state.counts = [{ status: 'success', result: 0 }, { status: 'success', result: 0 }, { status: 'success', result: 0 }, { status: 'success', result: 0 }];
  state.trades = {};
  state.failTrades = false;
  state.apiPositions = [];
});

describe('usePositions reads open positions from the chain', () => {
  // The 2026-10-10 report: the keeper filled the close in 3 s, the indexer was two days
  // behind, and the table kept showing the position as "Close requested — pending".
  it('shows no position once the chain has none, whatever the API still lists', () => {
    state.apiPositions = [apiStalePosition];
    const { result } = renderHook(() => usePositions(TRADER));
    expect(result.current.positions).toEqual([]);
    expect(result.current.source).toBe('chain');
  });

  it('lists the open slots of every pair that has trades, in the API shape', () => {
    state.counts[0] = { status: 'success', result: 2 };
    state.trades = { '0-0': trade(0), '0-2': trade(2) };
    const { result } = renderHook(() => usePositions(TRADER));
    expect(result.current.positions).toHaveLength(2);
    expect(result.current.positions[0]).toEqual({
      pairIndex: 0, index: 0, buy: true, collateral: '1000', leverage: '10', openPrice: '65000', tp: '0', sl: '60000',
      openedAt: 1_790_000_000, tradeId: '100',
    });
    expect(result.current.positions[1]!.index).toBe(2);
  });

  it('falls back to the API when a chain read fails', () => {
    state.counts[0] = { status: 'success', result: 1 };
    state.failTrades = true;
    state.apiPositions = [apiStalePosition];
    const { result } = renderHook(() => usePositions(TRADER));
    expect(result.current.source).toBe('api');
    expect(result.current.positions).toEqual([apiStalePosition]);
  });

  it('falls back to the API when the counts cannot be read', () => {
    state.counts = [{ status: 'failure' }];
    state.apiPositions = [apiStalePosition];
    const { result } = renderHook(() => usePositions(TRADER));
    expect(result.current.source).toBe('api');
  });
});
