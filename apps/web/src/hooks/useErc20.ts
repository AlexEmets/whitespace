'use client';

import type { Address } from 'viem';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { ERC20_ABI } from '@/lib/abi';
import { COLLATERAL_ADDRESS } from '@/lib/deployment';

/** USDW balance + allowance for `spender`, and the approve/claim(faucet) writes. Every
 * value returned is a raw bigint (6-decimal) — format it with src/lib/money.ts, never
 * with Number(). */
export function useErc20(spender: Address) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
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

  /**
   * Approves `spender` for `amount` and does not resolve until the transaction is mined.
   *
   * The wait is the point. `writeContractAsync` resolves when the wallet has *broadcast*
   * the transaction, not when it has landed, so a caller that refetches the allowance on
   * resolution reads the pre-approval value — and concludes approval is still needed.
   * That is exactly what happened here: the Approve button flipped to "Approving…", the
   * transaction mined perfectly, and the button then reverted to "Approve USDW" with the
   * order still unsubmittable. The trader's only recourse was to approve again, paying
   * gas twice, until a click happened to land after a block.
   *
   * Waiting inside `approve` rather than at the call site means no future caller can
   * reintroduce the race by forgetting to.
   */
  async function approve(amount: bigint): Promise<`0x${string}`> {
    const hash = await writeContractAsync({
      address: COLLATERAL_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amount],
    });
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Testnet faucet. Waits for the receipt for the same reason `approve` does — a caller
   * that refetches the balance on resolution would read the pre-claim value and conclude
   * the faucet did nothing. */
  async function claimFaucet(): Promise<`0x${string}`> {
    const hash = await writeContractAsync({
      address: COLLATERAL_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'claim',
      args: [],
    });
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
    return hash;
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
