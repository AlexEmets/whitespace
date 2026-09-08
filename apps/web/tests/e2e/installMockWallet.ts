import type { Page } from '@playwright/test';
import { CHAIN_INFO } from '../../src/lib/config';
import { createMockChain } from './mockChain';
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
export async function installMockWallet(page: Page, state: TestState): Promise<void> {
  const chain = createMockChain(state);

  await page.exposeFunction('__mockRpc', (payload: { method: string; params?: unknown[] }) => chain.handleRequest(payload));

  await page.addInitScript(() => {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    // @ts-expect-error injecting a fake EIP-1193 provider for tests
    window.ethereum = {
      isMetaMask: true,
      on(event: string, handler: (...args: unknown[]) => void) {
        (handlers[event] ??= []).push(handler);
      },
      removeListener(event: string, handler: (...args: unknown[]) => void) {
        handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
      },
      request(payload: { method: string; params?: unknown[] }) {
        // @ts-expect-error bridged in via page.exposeFunction
        return window.__mockRpc(payload);
      },
    };
  });

  await page.route(CHAIN_INFO.rpc, async (route) => {
    const body = route.request().postDataJSON() as { jsonrpc: string; id: number; method: string; params?: unknown[] };
    const result = await chain.handleRequest({ method: body.method, params: body.params });
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
  });
}
