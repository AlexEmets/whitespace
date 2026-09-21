'use client';

import type { Address } from 'viem';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { ERC20_ABI } from '@/lib/abi';
import { COLLATERAL_ADDRESS } from '@/lib/deployment';
import { confirmTx } from '@/lib/tx';

/**
 * The subset of `useErc20` a consumer needs. Named so helpers can take the handle as a
 * parameter (see `useFaucet`) without depending on `ReturnType<typeof useErc20>`, and so
 * a test double has one place to conform to.
 */
export interface Erc20Handle {
  /** Raw 6-decimal USDW. */
  balance: bigint;
  /** Raw 6-decimal USDW. Always 0n when the hook was called without a spender. */
  allowance: bigint;
  refetchBalance: () => unknown;
  refetchAllowance: () => unknown;
  approve: (amount: bigint) => Promise<`0x${string}`>;
  claimFaucet: () => Promise<`0x${string}`>;
  isWritePending: boolean;
}

/** USDW balance + allowance for `spender`, and the approve/claim(faucet) writes. Every
 * value returned is a raw bigint (6-decimal) — format it with src/lib/money.ts, never
 * with Number().
 *
 * `spender` is optional because allowance is only meaningful against one. A caller that
 * only mints and reads a balance (FaucetPanel) has no spender to name, and naming an
 * arbitrary contract just to satisfy the signature would put a number on screen that
 * describes a relationship the panel has nothing to do with. Omitting it disables the
 * allowance read outright rather than issuing one and ignoring the answer. */
export function useErc20(spender?: Address): Erc20Handle {
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
    args: address && spender ? [address, spender] : undefined,
    query: { enabled: Boolean(address) && Boolean(spender) },
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
    // Unreachable from any current caller — every component that approves passes a
    // spender. It throws rather than defaulting to some address, because an approval
    // granted to the wrong contract is exactly the failure this file's comment above
    // documents: a transaction that mines perfectly and authorises nothing.
    if (!spender) throw new Error('useErc20: approve requires a spender');
    const hash = await writeContractAsync({
      address: COLLATERAL_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amount],
    });
    if (publicClient) await confirmTx(publicClient, hash, 'approve USDW');
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
    if (publicClient) await confirmTx(publicClient, hash, 'claim from the faucet');
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
