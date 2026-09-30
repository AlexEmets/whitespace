// `injected` is the lightweight built-in connector re-exported from @wagmi/core via the
// main `wagmi` entry point. Deliberately NOT importing from `wagmi/connectors`
// (`@wagmi/connectors`) — that package's barrel pulls in every wallet SDK it ships
// (Coinbase, WalletConnect, Safe, ...) as one module graph, and Coinbase's `cdp-sdk`
// transitively references `@x402/*` packages that aren't installed, which breaks the
// production build with "Module not found" even though this app never uses that
// connector. The single `injected()` connector is all a MetaMask-style wallet needs.
import { createConfig, http, injected } from 'wagmi';
import { whitechainTestnet1874 } from './chain';

export { whitechainTestnet1874 };

export const wagmiConfig = createConfig({
  chains: [whitechainTestnet1874],
  connectors: [injected()],
  transports: {
    [whitechainTestnet1874.id]: http(),
  },
  ssr: true,
});
