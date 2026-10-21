// `injected` is the lightweight built-in connector re-exported from @wagmi/core via the
// main `wagmi` entry point. Deliberately NOT importing from `wagmi/connectors`
// (`@wagmi/connectors`) — that package's barrel pulls in every wallet SDK it ships
// (Coinbase, WalletConnect, Safe, ...) as one module graph, and Coinbase's `cdp-sdk`
// transitively references `@x402/*` packages that aren't installed, which breaks the
// production build with "Module not found" even though this app never uses that
// connector. The single `injected()` connector is all a MetaMask-style wallet needs.
import { createConfig, http, injected } from 'wagmi';
import { whitechainTestnet1874, whitechainMainnet1875 } from './chain';
import { RPC_URL } from './config';

export { whitechainTestnet1874, whitechainMainnet1875 };

// Testnet 1874 is the app's trading chain (first => wagmi's default). Mainnet 1875 is
// registered only so the Hunter badge reads (useHunterNfts, pinned to chainId 1875) have a
// transport; the wallet is never switched to it and trading never touches it.
export const wagmiConfig = createConfig({
  chains: [whitechainTestnet1874, whitechainMainnet1875],
  connectors: [injected()],
  transports: {
    [whitechainTestnet1874.id]: http(RPC_URL),
    [whitechainMainnet1875.id]: http(whitechainMainnet1875.rpcUrls.default.http[0]),
  },
  ssr: true,
});
