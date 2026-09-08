'use client';

import type { Address } from 'viem';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { ERC20_ABI } from '@/lib/abi';
import { COLLATERAL_ADDRESS } from '@/lib/deployment';

/** USDW balance + allowance for `spender`, and the approve/claim(faucet) writes. Every
 * value returned is a raw bigint (6-decimal) — format it with src/lib/money.ts, never
 * with Number(). */
export function useErc20(spender: Address) {
  const { address } = useAccount();
  const { writeContractAsync, isPending: isWritePending } = useWriteContract();

  const balance = useReadContract({
    address: COLLATERAL_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const allowance = useReadContract({
    address: COLLATERAL_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, spender] : undefined,
    query: { enabled: Boolean(address) },
  });

  async function approve(amount: bigint): Promise<`0x${string}`> {
    return writeContractAsync({
      address: COLLATERAL_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amount],
    });
  }

  async function claimFaucet(): Promise<`0x${string}`> {
    return writeContractAsync({
      address: COLLATERAL_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'claim',
      args: [],
    });
  }

  return {
    balance: balance.data ?? 0n,
    allowance: allowance.data ?? 0n,
    refetchBalance: balance.refetch,
    refetchAllowance: allowance.refetch,
    approve,
    claimFaucet,
    isWritePending,
  };
}
