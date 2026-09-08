'use client';

import { useAccount, useSwitchChain } from 'wagmi';
import { CHAIN_ID } from '@/lib/config';

/** Whether the connected wallet is on Whitechain testnet 1874, and a one-shot switch
 * request if it needs to prompt the user to change. */
export function useChainGuard() {
  const { chainId, isConnected } = useAccount();
  const { switchChain, isPending, error } = useSwitchChain();

  const isWrongChain = isConnected && chainId !== CHAIN_ID;

  return {
    isConnected,
    isWrongChain,
    isSwitching: isPending,
    switchError: error,
    requestSwitch: () => switchChain({ chainId: CHAIN_ID }),
  };
}
