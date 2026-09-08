/**
 * viem clients with RPC failover across >=2 endpoints — "RPC down -> failover across
 * >=2 endpoints" (design spec §7). Mirrors services/keeper/src/rpc.mjs's approach
 * exactly (same chain, same viem `fallback()` transport, same single-documented-endpoint
 * caveat) — not imported from keeper (services do not depend on each other here), but
 * deliberately identical in shape so an operator reading both services sees the same
 * pattern for the same concern.
 *
 * NOTE: only one public RPC endpoint for chain 1874 is documented today
 * (https://rpc.testnet.whitechain.io). `rpcUrls` is a configurable list so failover
 * activates the moment a second endpoint exists.
 */

import { createPublicClient, createWalletClient, defineChain, fallback, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const whitechainTestnet1874 = defineChain({
  id: 1874,
  name: 'whitechain-testnet-op',
  nativeCurrency: { name: 'White', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } },
});

/**
 * @param {object} opts
 * @param {string[]} opts.rpcUrls
 * @param {`0x${string}`} opts.forwarderPrivateKey
 * @param {import('viem').Chain} [opts.chain]
 */
export function createClients({ rpcUrls, forwarderPrivateKey, chain = whitechainTestnet1874 }) {
  if (!rpcUrls?.length) throw new Error('createClients: at least one RPC url is required');
  const transport = rpcUrls.length > 1 ? fallback(rpcUrls.map((url) => http(url))) : http(rpcUrls[0]);
  const account = privateKeyToAccount(forwarderPrivateKey);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  return { publicClient, walletClient, account };
}
