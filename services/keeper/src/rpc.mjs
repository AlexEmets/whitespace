/**
 * viem clients with RPC failover across >=2 endpoints — "RPC down -> failover across
 * >=2 endpoints" (design spec §7). viem's `fallback()` transport already implements
 * "try the next transport on failure"; this module just wires it up rather than
 * hand-rolling retry logic.
 *
 * NOTE: only one public RPC endpoint for chain 1874 is documented today
 * (https://rpc.testnet.whitechain.io — see docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md
 * §2.1). `rpcUrls` is a configurable list so failover activates the moment a second
 * endpoint exists; with a single URL configured, `fallback([...])` degrades to that
 * one transport (no failover to fail over to) — see the decisions doc for what this
 * means for what was and wasn't actually verified.
 */

import { createPublicClient, createWalletClient, defineChain, fallback, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Native currency symbol is not independently confirmed (not in scope for this
 * service); it only affects display formatting, never legacy tx construction. */
export const whitechainTestnet1874 = defineChain({
  id: 1874,
  name: 'whitechain-testnet-op',
  nativeCurrency: { name: 'White', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } },
});

/**
 * @param {object} opts
 * @param {string[]} opts.rpcUrls one or more RPC endpoints, tried in order
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
