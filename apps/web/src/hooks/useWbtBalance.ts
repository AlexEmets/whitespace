'use client';

import type { Address } from 'viem';
import { useBalance } from 'wagmi';
import { ERC20_REFRESH_MS } from './useErc20';

/**
 * The wallet's native WBT (gas) balance in wei, or `null` before it has been read.
 *
 * Polled on the USDW balance's cadence: the WBT faucet pays out from a server wallet, so
 * the balance moves without this tab sending anything, and the setup dialog has to see the
 * gas arrive to unlock its next step.
 */
export function useWbtBalance(address: Address | undefined): { wei: bigint | null } {
  const balance = useBalance({ address, query: { enabled: Boolean(address), refetchInterval: ERC20_REFRESH_MS } });
  return { wei: balance.data ? balance.data.value : null };
}
