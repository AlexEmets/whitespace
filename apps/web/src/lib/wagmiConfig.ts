import { defineChain } from 'viem';
// `injected` is the lightweight built-in connector re-exported from @wagmi/core via the
// main `wagmi` entry point. Deliberately NOT importing from `wagmi/connectors`
// (`@wagmi/connectors`) — that package's barrel pulls in every wallet SDK it ships
// (Coinbase, WalletConnect, Safe, ...) as one module graph, and Coinbase's `cdp-sdk`
// transitively references `@x402/*` packages that aren't installed, which breaks the
// production build with "Module not found" even though this app never uses that
// connector. The single `injected()` connector is all a MetaMask-style wallet needs.
import { createConfig, http, injected } from 'wagmi';
import { CHAIN_ID, CHAIN_INFO, RPC_URL } from './config';

/**
 * Whitechain testnet 1874, defined from @whitespace/shared's chain registry (rpc URL)
 * rather than re-typed here. Per the design spec §2.1, 1874 is an OP Stack rollup with
 * EIP-1559 active — no custom fee handling needed beyond what viem/wagmi do by default.
 */
export const whitechainTestnet1874 = defineChain({
  id: CHAIN_ID,
  name: 'Whitechain Testnet (1874)',
  nativeCurrency: { name: 'Whitechain', symbol: 'WBT', decimals: 18 },
  rpcUrls: {
    default: { http: [CHAIN_INFO.rpc] },
  },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [whitechainTestnet1874],
  connectors: [injected()],
  transports: {
    [whitechainTestnet1874.id]: http(),
  },
  ssr: true,
});
