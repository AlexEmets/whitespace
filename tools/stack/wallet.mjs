/**
 * An EIP-1193 wallet for a headless browser, backed by a real key held in Node.
 *
 * A headless Chromium has no MetaMask, so every connected-wallet state in this app —
 * portfolio balances, open positions, the order form, the faucet — is invisible to an
 * ordinary screenshot. That is most of the product. This attaches a provider to the page
 * whose calls are forwarded out to this process: reads are proxied verbatim to the chain's
 * JSON-RPC, and `eth_sendTransaction` is signed here with a role key and broadcast.
 *
 * Nothing is stubbed. The app builds the calldata, a real key signs it, the real chain
 * executes it. The only fiction is the wallet UI a human would have clicked through.
 *
 * The private key never enters the page: the browser can ask for a signature, it cannot
 * read the material that produces one.
 */

import { readFileSync } from 'node:fs';
import { createWalletClient, defineChain, http } from '../../apps/web/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../../apps/web/node_modules/viem/_esm/accounts/index.js';

export const DEFAULT_RPC_URL = 'https://rpc.testnet.whitechain.io';
export const DEFAULT_CHAIN_ID = 1874;

/**
 * @param {object} [opts]
 * @param {string} [opts.keyPath]  role key JSON (one-element array with address/private_key)
 * @param {string} [opts.rpcUrl]
 * @param {number} [opts.chainId]
 */
export function createWalletHarness(opts = {}) {
  const keyPath = opts.keyPath ?? `${process.env.HOME}/.whitespace-keys/dev.json`;
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const chainId = opts.chainId ?? DEFAULT_CHAIN_ID;

  const chain = defineChain({
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'Whitechain', symbol: 'WBT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });

  const raw = JSON.parse(readFileSync(keyPath, 'utf8'));
  const entry = Array.isArray(raw) ? raw[0] : raw;
  const account = privateKeyToAccount(entry.private_key);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const sentTxs = [];

  async function rpc(method, params) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }

  async function handle(method, params) {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address];
      case 'eth_chainId':
        return `0x${chainId.toString(16)}`;
      case 'net_version':
        return String(chainId);
      // Wallet-local methods. Forwarding these to a node answers "method not found", and
      // wagmi reads that as a dead provider rather than as an unsupported call.
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null;
      case 'wallet_getPermissions':
      case 'wallet_requestPermissions':
        return [{ parentCapability: 'eth_accounts' }];
      case 'eth_sendTransaction': {
        const tx = params[0];
        const hash = await walletClient.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          // The app's gas estimate is deliberately not forwarded: viem re-estimates
          // against the live node, and a stale estimate fails in a way that looks like an
          // application bug rather than a harness one.
        });
        sentTxs.push({ to: tx.to, hash });
        return hash;
      }
      case 'personal_sign':
        return account.signMessage({ message: { raw: params[0] } });
      default:
        return rpc(method, params);
    }
  }

  /**
   * Installs the provider on a Playwright BrowserContext. Must be called before the first
   * navigation — `addInitScript` runs ahead of page scripts, which is what lets wagmi see
   * `window.ethereum` during its own mount.
   */
  async function attach(context, onLog = () => {}) {
    await context.exposeFunction('__walletRequest', async (method, params) => {
      try {
        return { ok: true, result: await handle(method, params) };
      } catch (err) {
        onLog(`rpc error ${method}: ${err.message}`);
        // EIP-1193 errors must reach the page as a rejection carrying a code, or wagmi
        // reports a generic "connector not found" instead of the real reason.
        return { ok: false, error: { code: -32603, message: err.message } };
      }
    });

    await context.addInitScript(() => {
      const listeners = new Map();
      const provider = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          const res = await window.__walletRequest(method, params ?? []);
          if (!res.ok) {
            const err = new Error(res.error.message);
            err.code = res.error.code;
            throw err;
          }
          return res.result;
        },
        on: (event, handler) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(handler);
          return provider;
        },
        removeListener: (event, handler) => {
          listeners.get(event)?.delete(handler);
          return provider;
        },
      };
      Object.defineProperty(window, 'ethereum', { value: provider, writable: false, configurable: true });

      // EIP-6963: wagmi's injected connector prefers an announced provider where one
      // exists. Announced both eagerly and on request, to cover a connector that
      // subscribes after this script has run.
      const detail = Object.freeze({
        info: {
          uuid: '00000000-0000-4000-8000-000000000001',
          name: 'Whitespace Driver',
          icon: 'data:image/svg+xml,<svg/>',
          rdns: 'dev.whitespace.driver',
        },
        provider,
      });
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    });
  }

  return { account, walletClient, chain, attach, sentTxs };
}
