import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PositionSummary } from '@/lib/types';

const E18 = 10n ** 18n;
const TRADER = '0x1111111111111111111111111111111111111111';

const state = vi.hoisted(() => ({
  address: undefined as string | undefined,
  positions: [] as PositionSummary[],
  /** Liquidation answers keyed `${pair}-${index}`; a missing key is a failed read. */
  liq: {} as Record<string, bigint>,
  calls: [] as { functionName: string; args: readonly unknown[] }[][],
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: state.address }),
  useReadContracts: ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) => {
    state.calls.push(contracts);
    return {
      data: contracts.map((c) => {
        const answer = state.liq[`${c.args[1]}-${c.args[2]}`];
        return answer === undefined ? { status: 'failure', error: new Error('rpc') } : { status: 'success', result: answer };
      }),
    };
  },
}));

vi.mock('@/hooks/usePositions', () => ({
  usePositions: () => ({ positions: state.positions, loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [
      { pairIndex: 0, from: 'BTC', to: 'USD', feedId: '0x0', maxLeverage: '100.00', maxOpenInterest: '0', openInterest: { long: '0', short: '0' } },
      { pairIndex: 3, from: 'WBT', to: 'USD', feedId: '0x0', maxLeverage: '25.00', maxOpenInterest: '0', openInterest: { long: '0', short: '0' } },
    ],
    loading: false,
    error: null,
  }),
}));

import { usePositionLevels } from '@/hooks/usePositionLevels';

const position = (pairIndex: number, index: number, overrides: Partial<PositionSummary> = {}): PositionSummary => ({
  pairIndex,
  index,
  buy: true,
  collateral: '100.000000',
  leverage: '10.00',
  openPrice: '65000.000000000000000000',
  tp: '0',
  sl: '0',
  openedAt: 1_790_000_000,
  tradeId: `${pairIndex}${index}`,
  ...overrides,
});

const lastReads = () => state.calls[state.calls.length - 1] ?? [];

beforeEach(() => {
  state.address = TRADER;
  state.positions = [];
  state.liq = {};
  state.calls = [];
});

describe('usePositionLevels', () => {
  it("draws only the connected wallet's positions on the charted market", () => {
    state.positions = [position(0, 0), position(3, 0, { openPrice: '30.000000000000000000' }), position(0, 1)];
    state.liq = { '0-0': 58_500n * E18, '0-1': 59_000n * E18, '3-0': 27n * E18 };
    const { result } = renderHook(() => usePositionLevels(0));
    const entries = result.current.filter((l) => l.kind === 'entry');
    expect(entries).toHaveLength(2);
    expect(result.current.filter((l) => l.kind === 'liq').map((l) => l.price)).toEqual([58_500n * E18, 59_000n * E18]);
  });

  it("reads each liquidation price from the contract with that trade's own figures", () => {
    state.positions = [position(3, 2, { buy: false, collateral: '250.500000', leverage: '20.00', openPrice: '31.250000000000000000' })];
    renderHook(() => usePositionLevels(3));
    const reads = lastReads();
    expect(reads).toHaveLength(1);
    expect(reads[0]!.functionName).toBe('getTradeLiquidationPrice');
    // trader, pair, index, open price (1e18), long, collateral (1e6), leverage and the
    // pair's max leverage (both PRECISION_2, as numbers for viem's uint32 encoding).
    expect(reads[0]!.args).toEqual([TRADER, 3, 2, 31_250000000000000000n, false, 250_500000n, 2000, 2500]);
  });

  it('keeps the entry on the chart when a liquidation read fails, rather than guessing the level', () => {
    state.positions = [position(0, 0)];
    const { result } = renderHook(() => usePositionLevels(0));
    expect(result.current.map((l) => l.kind)).toEqual(['entry']);
  });

  it('draws nothing, and reads nothing, with no wallet connected — and draws once one connects', () => {
    state.address = undefined;
    state.positions = [position(0, 0)];
    state.liq = { '0-0': 58_500n * E18 };
    const { result, rerender } = renderHook(() => usePositionLevels(0));
    expect(result.current).toEqual([]);
    expect(lastReads()).toEqual([]);

    state.address = TRADER;
    rerender();
    expect(result.current.map((l) => l.kind)).toEqual(['entry', 'liq']);
  });

  it('draws nothing before a market is chosen, and draws once one is', () => {
    state.positions = [position(0, 0)];
    const { result, rerender } = renderHook(({ pair }: { pair: number | null }) => usePositionLevels(pair), {
      initialProps: { pair: null as number | null },
    });
    expect(result.current).toEqual([]);

    rerender({ pair: 0 });
    expect(result.current.map((l) => l.kind)).toEqual(['entry']);
  });
});
