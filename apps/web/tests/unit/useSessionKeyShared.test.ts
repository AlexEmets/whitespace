import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every trading hook calls useSessionKey() on its own. They must all see the same key: the
 * toggle enables one-click, and the order ticket is what signs the next trade. When each
 * instance held a private copy loaded at connect time, enabling updated the toggle only and
 * the ticket kept opening wallet pop-ups until a reload.
 */

const TRADER = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';

const state = vi.hoisted(() => ({
  delegate: '0x0000000000000000000000000000000000000000' as string,
  lastReadQuery: undefined as { refetchInterval?: number } | undefined,
  walletReady: true,
  gasWei: 10n ** 18n,
  sessionWrite: vi.fn(async () => '0xsession' as `0x${string}`),
  refetch: vi.fn(async () => undefined),
  writeContract: vi.fn(async (_args: { functionName: string; args?: readonly unknown[] }) => '0xhash'),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: TRADER }),
  usePublicClient: () => ({
    waitForTransactionReceipt: async () => ({ status: 'success', logs: [] }),
    getBalance: async () => 10n ** 18n,
    simulateContract: async (req: Record<string, unknown>) => ({ request: req }),
    estimateContractGas: async () => 100_000n,
  }),
  useWalletClient: () => ({ data: state.walletReady ? { writeContract: state.writeContract, sendTransaction: vi.fn() } : undefined }),
  useReadContract: (args: { query?: { refetchInterval?: number } }) => {
    state.lastReadQuery = args.query;
    return { data: state.delegate, refetch: state.refetch };
  },
  useBalance: () => ({ data: { value: state.gasWei }, refetch: vi.fn() }),
}));

vi.mock('@/lib/sessionKey', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/sessionKey')>()),
  buildSessionWalletClient: () => ({ writeContract: state.sessionWrite }),
}));

import { DELEGATION_REFRESH_MS, useSessionKey } from '@/hooks/useSessionKey';
import { clearSessionKey } from '@/lib/sessionKey';

beforeEach(() => {
  clearSessionKey(TRADER);
  state.delegate = ZERO;
  state.walletReady = true;
  state.gasWei = 10n ** 18n;
  state.sessionWrite.mockReset();
  state.sessionWrite.mockImplementation(async () => '0xsession');
  state.writeContract.mockClear();
  // The on-chain delegate becomes whatever setDelegate registered.
  state.writeContract.mockImplementation(async (args) => {
    if (args.functionName === 'setDelegate') state.delegate = args.args![0] as string;
    if (args.functionName === 'removeDelegate') state.delegate = ZERO;
    return '0xhash';
  });
});

describe('useSessionKey shares one key across every instance', () => {
  it('a key enabled from one instance is active in another that was mounted before it', async () => {
    const toggle = renderHook(() => useSessionKey());
    const ticket = renderHook(() => useSessionKey());
    expect(ticket.result.current.sessionAddress).toBeNull();

    await act(async () => {
      await toggle.result.current.enable();
    });
    toggle.rerender();
    ticket.rerender();

    expect(toggle.result.current.active).toBe(true);
    expect(ticket.result.current.sessionAddress).toBe(toggle.result.current.sessionAddress);
    expect(ticket.result.current.active).toBe(true);
  });

  it('turning one-click off in one instance drops the key everywhere', async () => {
    const toggle = renderHook(() => useSessionKey());
    const ticket = renderHook(() => useSessionKey());
    await act(async () => {
      await toggle.result.current.enable();
    });
    await act(async () => {
      await toggle.result.current.disable();
    });
    toggle.rerender();
    ticket.rerender();

    expect(ticket.result.current.sessionAddress).toBeNull();
    expect(ticket.result.current.active).toBe(false);
  });

  it('a key written by another tab reaches this one through the storage event', async () => {
    const ticket = renderHook(() => useSessionKey());
    const other = '0x' + 'ab'.repeat(32);
    await act(async () => {
      localStorage.setItem(`whitespace:1ct:1874:${TRADER}`, other);
      window.dispatchEvent(new StorageEvent('storage', { key: `whitespace:1ct:1874:${TRADER}` }));
    });
    expect(ticket.result.current.sessionAddress).not.toBeNull();
  });

  it('re-reads the on-chain delegate on a timer, so a revoke elsewhere turns the badge off', () => {
    renderHook(() => useSessionKey());
    expect(state.lastReadQuery?.refetchInterval).toBe(DELEGATION_REFRESH_MS);
  });

  it('says so when enable is clicked before the wallet client is ready, instead of doing nothing', async () => {
    state.walletReady = false;
    const toggle = renderHook(() => useSessionKey());
    await act(async () => {
      await toggle.result.current.enable();
    });
    expect(toggle.result.current.error).toMatch(/not ready/);
    expect(state.writeContract).not.toHaveBeenCalled();
  });

  // The delegate lands one transaction before the key is funded. A trade in that gap used to
  // be signed by the empty key and fail with the node's raw "total cost exceeds the balance".
  it('is active but not ready while the session key holds no gas', async () => {
    state.gasWei = 0n;
    const toggle = renderHook(() => useSessionKey());
    await act(async () => {
      await toggle.result.current.enable();
    });
    toggle.rerender();
    expect(toggle.result.current.active).toBe(true);
    expect(toggle.result.current.ready).toBe(false);

    state.gasWei = 10n ** 16n;
    toggle.rerender();
    expect(toggle.result.current.ready).toBe(true);
  });

  it('says the key is out of gas instead of passing the node error through', async () => {
    const toggle = renderHook(() => useSessionKey());
    await act(async () => {
      await toggle.result.current.enable();
    });
    toggle.rerender();
    state.sessionWrite.mockImplementation(async () => {
      throw new Error('The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.');
    });
    await expect(toggle.result.current.send('updateTp', [0, 0, 1n], 'update TP')).rejects.toThrow(/out of gas.*Fund gas/);
  });

  it('passes any other send failure through unchanged', async () => {
    const toggle = renderHook(() => useSessionKey());
    await act(async () => {
      await toggle.result.current.enable();
    });
    toggle.rerender();
    state.sessionWrite.mockImplementation(async () => {
      throw new Error('nonce too low');
    });
    await expect(toggle.result.current.send('updateTp', [0, 0, 1n], 'update TP')).rejects.toThrow('nonce too low');
  });
});
