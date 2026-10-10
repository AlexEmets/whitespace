import { defineChain } from 'viem';
import { CHAIN_ID, RPC_URL } from './config';

/**
 * Whitechain testnet 1874, defined from @whitespace/shared's chain registry (rpc URL)
 * rather than re-typed. Per the design spec §2.1, 1874 is an OP Stack rollup with EIP-1559
 * active — no custom fee handling needed beyond what viem/wagmi do by default.
 *
 * Lives in its own module (not wagmiConfig) so a pure lib — the one-click-trading session
 * key builds its own viem WalletClient over this chain — can import the chain without
 * pulling in wagmi and instantiating the connector graph.
 */
export const whitechainTestnet1874 = defineChain({
  id: CHAIN_ID,
  name: 'Whitechain Testnet (1874)',
  nativeCurrency: { name: 'Whitechain', symbol: 'WBT', decimals: 18 },
  rpcUrls: {
    // RPC_URL, not the registry's public endpoint: wagmi's http() transport and every client
    // built over this chain read from here. It used to be CHAIN_INFO.rpc, so
    // NEXT_PUBLIC_RPC_URL (the eRPC cache behind /rpc) was ignored for every read the app
    // made and the browser hit the rate-limited public RPC directly.
    default: { http: [RPC_URL] },
  },
  testnet: true,
});
