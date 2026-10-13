import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => [] as { functionName: string; query?: { refetchInterval?: number } }[]);
const readData = vi.hoisted(() => ({ value: 0n as bigint | undefined }));
const wallet = vi.hoisted(() => ({ chainId: 1874, calls: [] as string[], writes: [] as { functionName: string; chainId?: number }[] }));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', chainId: wallet.chainId }),
  usePublicClient: () => ({ waitForTransactionReceipt: async () => ({ status: 'success' }) }),
  useWriteContract: () => ({
    writeContractAsync: async (request: { functionName: string; chainId?: number }) => {
      wallet.calls.push(`write:${request.functionName}`);
      wallet.writes.push(request);
      return '0xhash';
    },
    isPending: false,
  }),
  useSwitchChain: () => ({
    switchChainAsync: async ({ chainId }: { chainId: number }) => {
      wallet.calls.push(`switch:${chainId}`);
    },
  }),
  useReadContract: (args: { functionName: string; query?: { refetchInterval?: number } }) => {
    reads.push(args);
    return { data: readData.value, refetch: vi.fn() };
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

/** Before the first read lands, `balance` is a stand-in 0n — indistinguishable from an
 * empty wallet unless the handle says it has not been read yet. */
describe('useErc20 says whether the balance has been read', () => {
  it('is unread while the read has no data, even though the balance shows 0', () => {
    readData.value = undefined;
    const { result } = renderHook(() => useErc20());
    expect(result.current.balance).toBe(0n);
    expect(result.current.balanceLoaded).toBe(false);
  });

  it('is read once data arrives, including a genuine zero', () => {
    readData.value = 0n;
    const { result } = renderHook(() => useErc20());
    expect(result.current.balance).toBe(0n);
    expect(result.current.balanceLoaded).toBe(true);
  });
});

/** The setup dialog's USDW claim offered to sign on Ethereum mainnet from a wallet browser
 * left there. The claim goes through useErc20, so this is where it is pinned. */
describe('useErc20 claims and approves on Whitechain testnet only', () => {
  it('switches a wallet on another network to 1874 before the faucet claim', async () => {
    wallet.chainId = 1;
    wallet.calls.length = 0;
    wallet.writes.length = 0;
    const { result } = renderHook(() => useErc20('0x2222222222222222222222222222222222222222'));
    await result.current.claimFaucet();
    expect(wallet.calls).toEqual(['switch:1874', 'write:claim']);
    expect(wallet.writes[0]!.chainId).toBe(1874);
  });

  it('signs an approval on 1874 without asking to switch when already there', async () => {
    wallet.chainId = 1874;
    wallet.calls.length = 0;
    wallet.writes.length = 0;
    const { result } = renderHook(() => useErc20('0x2222222222222222222222222222222222222222'));
    await result.current.approve(1n);
    expect(wallet.calls).toEqual(['write:approve']);
    expect(wallet.writes[0]!.chainId).toBe(1874);
  });
});
