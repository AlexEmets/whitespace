import { renderHook } from '@testing-library/react';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { VAULT_ABI } from '@/lib/abi';
import { VAULT_ADDRESS } from '@/lib/deployment';

const OWNER = '0x1111111111111111111111111111111111111111';

/** A receipt whose request event names `settlementId`. */
function receiptFor(eventName: 'DepositRequestedV2' | 'WithdrawRequestedV2', settlementId: number) {
  return {
    status: 'success',
    logs: [
      {
        address: VAULT_ADDRESS,
        topics: encodeEventTopics({ abi: VAULT_ABI, eventName, args: { owner: OWNER, settlementId } }),
        data: encodeAbiParameters([{ type: 'uint256' }], [5n]),
        blockNumber: 1n, transactionHash: '0x' + '1'.repeat(64), logIndex: 0, blockHash: '0x' + '2'.repeat(64),
        transactionIndex: 0, removed: false,
      },
    ],
  };
}

const state = vi.hoisted(() => ({ receipt: null as unknown, target: 5 }));

const vaultWrites = vi.hoisted(() => [] as { chainId?: number }[]);

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  usePublicClient: () => ({
    readContract: async () => state.target,
    waitForTransactionReceipt: async () => state.receipt,
  }),
  useWriteContract: () => ({
    writeContractAsync: async (request: { chainId?: number }) => {
      vaultWrites.push(request);
      return '0xhash';
    },
    isPending: false,
  }),
  // Already on 1874: the testnet guard (useTestnetWriteContract) has nothing to switch.
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useReadContract: () => ({ data: undefined }),
}));

import { useVault } from '@/hooks/useVault';

describe('useVault takes the settlement id from the request event', () => {
  it('deposit: uses the id the event names when a settlement moved the target in between', async () => {
    state.target = 5;
    state.receipt = receiptFor('DepositRequestedV2', 6);
    const { result } = renderHook(() => useVault());
    expect((await result.current.requestDeposit(5n)).settlementId).toBe(6);
  });

  it('withdraw: same, from WithdrawRequestedV2', async () => {
    state.target = 8;
    state.receipt = receiptFor('WithdrawRequestedV2', 9);
    const { result } = renderHook(() => useVault());
    expect((await result.current.requestWithdraw(5n)).settlementId).toBe(9);
  });

  it('falls back to the pre-read target when the receipt carries no event', async () => {
    state.target = 5;
    state.receipt = { status: 'success', logs: [] };
    const { result } = renderHook(() => useVault());
    expect((await result.current.requestDeposit(5n)).settlementId).toBe(5);
  });
});

describe('useVault signs on Whitechain testnet only', () => {
  it('names chain 1874 on the request, so a wallet elsewhere cannot sign it there', async () => {
    vaultWrites.length = 0;
    const { result } = renderHook(() => useVault());
    await result.current.requestDeposit(5n);
    expect(vaultWrites).toHaveLength(1);
    expect(vaultWrites[0]!.chainId).toBe(1874);
  });
});
