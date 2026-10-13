'use client';

import { useCallback, useRef } from 'react';
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi';
import { CHAIN_ID, CHAIN_INFO } from '@/lib/config';

/**
 * Every transaction this app asks a wallet to sign belongs on Whitechain testnet — and
 * nothing used to make sure it went there.
 *
 * wagmi's `writeContract` without a `chainId` sends on whatever network the wallet happens
 * to be on (it hands viem `chain: null`, which skips the chain check). A wallet browser on
 * Ethereum mainnet therefore offered to sign the USDW claim on mainnet: the setup dialog's
 * button, the faucet, an order, a close — every write. The wrong-network banner only asked
 * nicely.
 *
 * So each write now does two things. It switches the wallet to 1874 first — the wallet adds
 * the network if it does not know it — and it passes `chainId`, so viem checks the wallet's
 * network at signing time and refuses rather than sending anywhere else if the switch did
 * not take.
 */

/** What a wallet that has never seen 1874 is asked to add. The public RPC, not the app's
 * own cache (RPC_URL): the wallet keeps this entry long after this tab is gone. */
export const TESTNET_SWITCH = {
  chainId: CHAIN_ID,
  addEthereumChainParameter: {
    chainName: 'Whitechain Testnet',
    nativeCurrency: { name: 'Whitechain', symbol: 'WBT', decimals: 18 },
    rpcUrls: [CHAIN_INFO.rpc],
    blockExplorerUrls: ['https://explorer.testnet.whitechain.io'],
  },
};

/** Resolves once the wallet is on 1874, asking it to switch when it is not. Throws if the
 * trader declines. */
export function useEnsureTestnet(): () => Promise<void> {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  // A ref, so a flow that switches and then signs twice (claim, then approve) reads the
  // network the wallet is on now rather than the one this render saw.
  const current = useRef(chainId);
  current.current = chainId;
  return useCallback(async () => {
    if (current.current === CHAIN_ID) return;
    await switchChainAsync(TESTNET_SWITCH);
    current.current = CHAIN_ID;
  }, [switchChainAsync]);
}

type WriteContractAsync = ReturnType<typeof useWriteContract>['writeContractAsync'];

/** `useWriteContract`, pinned to 1874: same `{ writeContractAsync, isPending }` shape, so a
 * hook swaps one for the other without touching its call sites. */
export function useTestnetWriteContract(): { writeContractAsync: WriteContractAsync; isPending: boolean } {
  const ensureTestnet = useEnsureTestnet();
  const { writeContractAsync, isPending } = useWriteContract();
  const write = useCallback(
    async (...[request, ...rest]: Parameters<WriteContractAsync>) => {
      await ensureTestnet();
      return writeContractAsync({ ...request, chainId: CHAIN_ID } as typeof request, ...rest);
    },
    [ensureTestnet, writeContractAsync],
  ) as WriteContractAsync;
  return { writeContractAsync: write, isPending };
}
