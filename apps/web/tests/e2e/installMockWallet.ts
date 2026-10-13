import type { Page } from '@playwright/test';
import { CHAIN_ID, CHAIN_INFO } from '../../src/lib/config';
import { TERMS_ACCEPTED_KEY, TERMS_VERSION } from '../../src/lib/legal';
import { createMockChain, UnmockedCallError } from './mockChain';
import type { TestState } from './testState';

/**
 * Wires a page up to the mock chain two ways, because wagmi itself uses two different
 * transports for the two kinds of calls this app makes:
 *
 *  - Wallet-signed writes (`eth_sendTransaction`, `eth_requestAccounts`, ...) go through
 *    the *connector's* EIP-1193 provider — `window.ethereum` here, bridged to Node via
 *    `page.exposeFunction`.
 *  - Public reads (`eth_call`, `eth_getTransactionReceipt`, ...) go through the
 *    `http()` transport configured in src/lib/wagmiConfig.ts, which POSTs JSON-RPC
 *    directly to the chain's RPC URL — NOT through `window.ethereum`. Missing this the
 *    first time round sent every balance/allowance/receipt read to the real Whitechain
 *    testnet RPC instead of the mock, which is why erc20 balances silently read as zero
 *    in early runs of this suite.
 *
 * Both paths are routed to the same `TestState`, so a write made via the wallet path is
 * immediately visible to a read made via the RPC path.
 */

/** A wallet to announce over EIP-6963 on top of `window.ethereum`. */
export type AnnouncedWallet = { uuid: string; name: string; rdns: string };

export type MockWalletOptions = {
  /**
   * Wallets to announce over EIP-6963. wagmi's `multiInjectedProviderDiscovery` (on by
   * default) turns each announcement into its own connector, which is what makes the
   * wallet picker appear instead of the single-option fast path. Left empty, only
   * `window.ethereum` exists and the Connect button connects in one click — which is what
   * trade-flow.spec.ts relies on.
   */
  announce?: readonly AnnouncedWallet[];
  /**
   * Make every provider report no accounts until `eth_requestAccounts` is called on it,
   * which is what a real wallet does for a site it has not been authorised on.
   *
   * mockChain.ts answers `eth_accounts` with the trader address unconditionally, so
   * wagmi's `reconnectOnMount` connects before the page has painted and the Connect
   * button is torn out from under any click — the flake drive-trade.mjs describes as
   * "the app is frequently connected before the first frame". Any test that needs to
   * observe the disconnected state has to close that hole. Off by default so the
   * existing specs keep the behaviour they were written against.
   */
  startsUnauthorized?: boolean;
  /**
   * Put a wallet at `window.ethereum` that announces nothing, identified only by a vendor
   * flag (e.g. `'isTrust'`). Models an extension too old for EIP-6963: the picker cannot
   * match it by rdns and has to fall back to offering the generic connector, labelled
   * from the flag.
   *
   * Without this, `window.ethereum` is the *same object* as the first announced wallet's
   * provider, which is what a real browser looks like when the extension that won the
   * injection race also announces itself.
   */
  silentWallet?: { flag: string };
  /**
   * Put the wallet on another network to start with (e.g. 1, Ethereum mainnet), the way a
   * wallet browser left on mainnet arrives. The wallet then answers `eth_chainId` itself,
   * moves on `wallet_switchEthereumChain`, and REFUSES any `eth_sendTransaction` while it
   * is off 1874 — recording it in `window.__offChainSends`, so a spec can prove nothing was
   * ever offered for signing on the wrong network. Unset, the wallet is on 1874 throughout.
   */
  walletChainId?: number;
  /**
   * Whether this browser has already agreed to the Terms (TermsGate). On by default, so
   * the agreement dialog stays out of every spec that is not about it; a spec that drives
   * the agreement itself turns it off.
   */
  termsAccepted?: boolean;
};

/** A 1×1 transparent SVG. EIP-6963 requires `info.icon`; its content is irrelevant here. */
const BLANK_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';

export async function installMockWallet(
  page: Page,
  state: TestState,
  options: MockWalletOptions = {},
): Promise<void> {
  const chain = createMockChain(state);

  await page.exposeFunction('__mockRpc', (payload: { method: string; params?: unknown[] }) => chain.handleRequest(payload));

  if (options.termsAccepted ?? true) {
    await page.addInitScript(
      ([key, version]: [string, string]) => {
        localStorage.setItem(key, version);
      },
      [TERMS_ACCEPTED_KEY, TERMS_VERSION] as [string, string],
    );
  }

  await page.addInitScript(
    ([announce, icon, startsUnauthorized, silentWallet, walletChainId, homeChainId]: [
      readonly AnnouncedWallet[],
      string,
      boolean,
      { flag: string } | null,
      number | null,
      number,
    ]) => {
      const toHex = (n: number) => `0x${n.toString(16)}`;
      function makeProvider() {
        const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
        let authorized = !startsUnauthorized;
        let onChain = walletChainId;
        return {
          isMetaMask: true,
          on(event: string, handler: (...args: unknown[]) => void) {
            (handlers[event] ??= []).push(handler);
          },
          removeListener(event: string, handler: (...args: unknown[]) => void) {
            handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
          },
          request(payload: { method: string; params?: unknown[] }) {
            // Authorisation is per provider object, so connecting through one announced
            // wallet does not silently authorise the others.
            if (payload.method === 'eth_requestAccounts') authorized = true;
            if (payload.method === 'eth_accounts' && !authorized) return Promise.resolve([]);
            if (onChain !== null) {
              if (payload.method === 'eth_chainId') return Promise.resolve(toHex(onChain));
              if (payload.method === 'wallet_switchEthereumChain') {
                onChain = parseInt((payload.params?.[0] as { chainId: string }).chainId, 16);
                for (const handler of handlers.chainChanged ?? []) handler(toHex(onChain));
                return Promise.resolve(null);
              }
              if (payload.method === 'eth_sendTransaction' && onChain !== homeChainId) {
                const w = window as unknown as { __offChainSends?: number[] };
                (w.__offChainSends ??= []).push(onChain);
                return Promise.reject(Object.assign(new Error(`mock wallet: refused to send on chain ${onChain}`), { code: -32000 }));
              }
            }
            // @ts-expect-error bridged in via page.exposeFunction
            return window.__mockRpc(payload);
          },
        };
      }

      // Each announced wallet gets its OWN provider object. wagmi keys connectors by the
      // announced rdns, so distinct objects are what let a test prove the picker connected
      // the row that was clicked rather than whatever owns window.ethereum.
      const details = announce.map((wallet) =>
        Object.freeze({
          info: Object.freeze({ uuid: wallet.uuid, name: wallet.name, rdns: wallet.rdns, icon }),
          provider: makeProvider(),
        }),
      );

      // Identity matters here, not just presence: the picker decides whether to offer the
      // generic connector by comparing window.ethereum against the announced providers.
      const first = details[0];
      // @ts-expect-error injecting a fake EIP-1193 provider for tests
      window.ethereum = silentWallet
        ? Object.assign(makeProvider(), { [silentWallet.flag]: true })
        : (first?.provider ?? makeProvider());

      if (details.length === 0) return;
      const announceAll = () => {
        for (const detail of details) {
          window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
        }
      };
      // Announce both on load and on request: mipd asks for providers when its store is
      // created, which may be before or after this script runs.
      window.addEventListener('eip6963:requestProvider', announceAll);
      announceAll();
    },
    [
      options.announce ?? [],
      BLANK_ICON,
      options.startsUnauthorized ?? false,
      options.silentWallet ?? null,
      options.walletChainId ?? null,
      CHAIN_ID,
    ] as [readonly AnnouncedWallet[], string, boolean, { flag: string } | null, number | null, number],
  );

  await page.route(CHAIN_INFO.rpc, async (route) => {
    const body = route.request().postDataJSON() as { jsonrpc: string; id: number; method: string; params?: unknown[] };
    try {
      const result = await chain.handleRequest({ method: body.method, params: body.params });
      await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
    } catch (err) {
      if (!(err instanceof UnmockedCallError)) throw err;
      await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, error: { code: 3, message: err.message } } });
    }
  });
}
