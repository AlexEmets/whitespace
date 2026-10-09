import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => [] as { functionName: string; query?: { refetchInterval?: number } }[]);

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  usePublicClient: () => ({}),
  useWriteContract: () => ({ writeContractAsync: vi.fn(), isPending: false }),
  useReadContract: (args: { functionName: string; query?: { refetchInterval?: number } }) => {
    reads.push(args);
    return { data: 0n, refetch: vi.fn() };
  },
}));

import { ERC20_REFRESH_MS, useErc20 } from '@/hooks/useErc20';

/** USDW moves when a keeper fills, a close pays out or a reclaim refunds — none of which this
 * tab does — so the balance and allowance must refresh on their own. */
describe('useErc20 keeps balance and allowance current', () => {
  it('polls both reads', () => {
    reads.length = 0;
    renderHook(() => useErc20('0x2222222222222222222222222222222222222222'));
    const balance = reads.find((r) => r.functionName === 'balanceOf');
    const allowance = reads.find((r) => r.functionName === 'allowance');
    expect(balance?.query?.refetchInterval).toBe(ERC20_REFRESH_MS);
    expect(allowance?.query?.refetchInterval).toBe(ERC20_REFRESH_MS);
    expect(ERC20_REFRESH_MS).toBeLessThanOrEqual(5_000);
  });
});
