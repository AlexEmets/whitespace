import { defineChain } from 'viem';
import { CHAINS } from '@whitespace/shared/chains';
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

/**
 * Whitechain mainnet 1875. The app trades on testnet 1874, but the Hunter bug-bounty badges
 * live on mainnet, so their chain reads (see useHunterNfts) target this chain explicitly —
 * independent of whatever network the connected wallet is on. The RPC comes from
 * @whitespace/shared's registry, overridable with NEXT_PUBLIC_HUNTER_RPC_URL for a private
 * endpoint. Unlike 1874, mainnet is not EIP-1559 (registry `expects.eip1559: false`), but the
 * badge reads are `eth_call`s, so no fee handling is involved here.
 */
const MAINNET_INFO = CHAINS[1875];
if (!MAINNET_INFO) {
  throw new Error('@whitespace/shared/chains has no entry for chain 1875');
}
const MAINNET_RPC = process.env.NEXT_PUBLIC_HUNTER_RPC_URL ?? MAINNET_INFO.rpc;
export const whitechainMainnet1875 = defineChain({
  id: MAINNET_INFO.id,
  name: 'Whitechain',
  nativeCurrency: { name: 'Whitechain', symbol: 'WBT', decimals: 18 },
  rpcUrls: {
    default: { http: [MAINNET_RPC] },
  },
});
