'use client';

import { useAccount, useSwitchChain } from 'wagmi';
import { CHAIN_ID } from '@/lib/config';
import { TESTNET_SWITCH } from './useTestnetWriteContract';

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
    // Same request every write makes, so a wallet that has never seen 1874 is offered the
    // network with its public RPC and explorer rather than failing the switch.
    requestSwitch: () => switchChain(TESTNET_SWITCH),
  };
}
