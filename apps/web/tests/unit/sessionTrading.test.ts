import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One-click trading routes every write through the session key (delegatedAction, no popup)
 * when active, and through the normal wallet path otherwise. These tests pin that branch for
 * open, close and the position/order management writes.
 */

const state = vi.hoisted(() => ({
  active: false,
  writeContractAsync: vi.fn(async () => '0xwallethash'),
  sessionSend: vi.fn(
    async (_functionName: string, _args: readonly unknown[], _describe: string) => ({
      hash: '0xsessionhash',
      receipt: { status: 'success', logs: [] },
    }),
  ),
  simulateContract: vi.fn(async () => ({ request: { functionName: 'x', args: [], address: '0x', abi: [], account: '0xTRADER' } })),
}));

const publicClient = {
  estimateContractGas: vi.fn(async () => 100_000n),
  waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', logs: [] })),
  simulateContract: state.simulateContract,
};

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xTRADER0000000000000000000000000000000000' }),
  usePublicClient: () => publicClient,
  useWriteContract: () => ({ writeContractAsync: state.writeContractAsync, isPending: false }),
}));

vi.mock('@/hooks/useSessionKey', () => ({
  useSessionKey: () => ({ active: state.active, send: state.sessionSend }),
}));

import { useCloseTrade } from '@/hooks/useCloseTrade';
import { useOpenTrade } from '@/hooks/useOpenTrade';
import { useTradingActions } from '@/hooks/useTradingActions';

const OPEN = {
  pairIndex: 0,
  buy: true,
  collateralRaw: 100_000000n,
  leverageRaw: 1000n,
  wantedPriceRaw: 65_000n * 10n ** 18n,
  slippageBps: 50n,
} as const;

beforeEach(() => {
  state.active = false;
  state.writeContractAsync.mockClear();
  state.sessionSend.mockClear();
  state.simulateContract.mockClear();
});

describe('useOpenTrade one-click branch', () => {
  it('signs with the wallet when one-click trading is off', async () => {
    const { result } = renderHook(() => useOpenTrade());
    await result.current.openTrade(OPEN);
    expect(state.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(state.sessionSend).not.toHaveBeenCalled();
  });

  it('signs through the session key when one-click trading is on', async () => {
    state.active = true;
    const { result } = renderHook(() => useOpenTrade());
    await result.current.openTrade(OPEN);
    expect(state.sessionSend).toHaveBeenCalledTimes(1);
    expect(state.sessionSend.mock.calls[0]![0]).toBe('openTrade');
    expect(state.writeContractAsync).not.toHaveBeenCalled();
  });
});

describe('useCloseTrade one-click branch', () => {
  const CLOSE = { pairIndex: 0, index: 1, closePercentage: 10000, marketPriceRaw: 65_000n * 10n ** 18n, slippageBps: 50n };

  it('simulates and signs with the wallet when off', async () => {
    const { result } = renderHook(() => useCloseTrade());
    await result.current.closeTrade(CLOSE);
    expect(state.simulateContract).toHaveBeenCalledTimes(1);
    expect(state.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(state.sessionSend).not.toHaveBeenCalled();
  });

  it('signs through the session key (no wallet simulate) when on', async () => {
    state.active = true;
    const { result } = renderHook(() => useCloseTrade());
    await result.current.closeTrade(CLOSE);
    expect(state.sessionSend).toHaveBeenCalledTimes(1);
    expect(state.sessionSend.mock.calls[0]![0]).toBe('closeTradeMarket');
    expect(state.simulateContract).not.toHaveBeenCalled();
    expect(state.writeContractAsync).not.toHaveBeenCalled();
  });
});

describe('useTradingActions one-click branch', () => {
  it('simulates and signs with the wallet when off', async () => {
    const { result } = renderHook(() => useTradingActions());
    await result.current.updateTp(0, 1, 70_000n * 10n ** 18n);
    expect(state.simulateContract).toHaveBeenCalledTimes(1);
    expect(state.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(state.sessionSend).not.toHaveBeenCalled();
  });

  it('signs through the session key when on, carrying the function and args', async () => {
    state.active = true;
    const { result } = renderHook(() => useTradingActions());
    await result.current.updateTp(0, 1, 70_000n * 10n ** 18n);
    expect(state.sessionSend).toHaveBeenCalledTimes(1);
    expect(state.sessionSend.mock.calls[0]![0]).toBe('updateTp');
    expect(state.sessionSend.mock.calls[0]![1]).toEqual([0, 1, 70_000n * 10n ** 18n]);
    expect(state.simulateContract).not.toHaveBeenCalled();
  });
});
