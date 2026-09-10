/**
 * Opens a position through the actual web UI, in a real browser, against the real chain.
 *
 * WHY THIS EXISTS. Every other proof this repo has that a trade works went through
 * `forge script` — the contract path, not the product. The frontend's own order flow
 * (wagmi -> injected connector -> writeContract -> the keeper's two-phase fill) had never
 * been executed end to end, so nothing established that a person with a wallet could
 * actually trade here. A headless browser has no MetaMask, which is the usual reason this
 * check gets skipped.
 *
 * HOW THE WALLET WORKS. `window.ethereum` is injected into the page as a real EIP-1193
 * provider whose every call is forwarded, via a Playwright binding, out to this Node
 * process. Read methods are proxied verbatim to the chain's JSON-RPC. `eth_sendTransaction`
 * is signed here by viem with the trader role key and broadcast. Nothing is stubbed: the
 * app builds the calldata, a real key signs it, the real chain executes it. The only
 * fiction is the wallet UI a human would have clicked through.
 *
 * The private key never enters the page. The browser can ask for a signature; it cannot
 * read the material that produces one.
 *
 * Usage:
 *   node tools/stack/drive-trade.mjs [--collateral 25] [--leverage 5] [--short]
 *                                    [--url http://127.0.0.1:3100/trade] [--out /tmp/x.png]
 */

import { readFileSync } from 'node:fs';
// Reached by path, not by bare specifier: viem and Playwright are dependencies of
// apps/web, and pnpm does not hoist them to a root node_modules a file under tools/ could
// resolve from. The `_esm/` entry is the package's own ESM build (its "module" field) —
// `viem/index.mjs` does not exist, only the exports map points at it, and an exports map
// is not consulted for a path import.
import { createWalletClient, createPublicClient, defineChain, http } from '../../apps/web/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../../apps/web/node_modules/viem/_esm/accounts/index.js';
import { chromium } from '../../apps/web/node_modules/@playwright/test/index.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const RPC_URL = 'https://rpc.testnet.whitechain.io';
const CHAIN_ID = 1874;
const KEY_PATH = flag('key', `${process.env.HOME}/.whitespace-keys/dev.json`);
const URL = flag('url', 'http://127.0.0.1:3100/trade');
const OUT = flag('out', '/tmp/whitespace-trade.png');
const COLLATERAL = flag('collateral', '25');
const LEVERAGE = Number(flag('leverage', '5'));
const SHORT = args.includes('--short');

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Whitechain Testnet',
  nativeCurrency: { name: 'Whitechain', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});

const raw = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
const entry = Array.isArray(raw) ? raw[0] : raw;
const account = privateKeyToAccount(entry.private_key);
const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

console.log(`trader     ${account.address}`);
console.log(`url        ${URL}`);
console.log(`order      ${SHORT ? 'SHORT' : 'LONG'} ${COLLATERAL} USDW @ ${LEVERAGE}x`);

/** Raw JSON-RPC passthrough for every read the app makes. */
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const sentTxs = [];

async function handleWalletRequest(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [account.address];
    case 'eth_chainId':
      return `0x${CHAIN_ID.toString(16)}`;
    case 'net_version':
      return String(CHAIN_ID);
    // Wallets answer these locally; forwarding them to a node returns "method not found"
    // and wagmi treats that as a dead provider.
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
        // Deliberately not forwarding the app's gas estimate: viem re-estimates against
        // the live node, and a stale estimate is the one failure here that would look
        // like an application bug rather than a driver bug.
      });
      sentTxs.push({ to: tx.to, hash });
      console.log(`  tx -> ${hash}`);
      return hash;
    }
    case 'personal_sign':
      return account.signMessage({ message: { raw: params[0] } });
    default:
      return rpc(method, params);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));

await context.exposeFunction('__walletRequest', async (method, params) => {
  try {
    return { ok: true, result: await handleWalletRequest(method, params) };
  } catch (err) {
    // EIP-1193 errors must surface to the page as rejections carrying a code, otherwise
    // wagmi reports the generic "connector not found" instead of the real reason.
    console.log(`  rpc error ${method}: ${err.message}`);
    return { ok: false, error: { code: -32603, message: err.message } };
  }
});

await context.addInitScript(() => {
  const listeners = new Map();
  const provider = {
    isMetaMask: true,
    // EIP-1193. Everything is delegated; the page holds no key material and no signing
    // logic of its own.
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

  // EIP-6963: wagmi's injected connector prefers an announced provider when one exists.
  // Announcing on demand as well as at load covers the connector subscribing after us.
  const detail = Object.freeze({
    info: { uuid: '00000000-0000-4000-8000-000000000001', name: 'Whitespace Driver', icon: 'data:image/svg+xml,<svg/>', rdns: 'dev.whitespace.driver' },
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });

// --- connect -------------------------------------------------------------------------
// wagmi reconnects on mount, and this provider answers `eth_accounts` with the trader
// straight away — which is exactly how an already-authorised MetaMask behaves. So the
// app is frequently connected before the first frame and the Connect button never
// renders. Click it only if it is actually there.
const connectButton = page.getByTestId('connect-wallet-button');
if (await connectButton.count()) {
  await connectButton.click();
} else {
  console.log('connect    (auto-reconnected — no Connect button rendered)');
}
await page.getByTestId('wallet-connected').waitFor({ timeout: 30_000 });
console.log(`connected  ${await page.getByTestId('wallet-address').innerText()}`);

// The balance and the reference price both arrive asynchronously; the form refuses to
// submit without them, so waiting on the price is what makes the rest deterministic.
// reference-price is a readOnly <input>: its price lives in .value, and textContent is
// always the empty string. Checking textContent here waits forever on a field that is
// already populated.
await page.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="reference-price"]');
    return el instanceof HTMLInputElement && el.value !== '' && !el.value.includes('—');
  },
  { timeout: 30_000 },
);
console.log(`balance    ${await page.getByTestId('usdw-balance').innerText()}`);
console.log(`reference  ${await page.getByTestId('reference-price').inputValue()}`);

// --- order entry ---------------------------------------------------------------------
await page.getByTestId(SHORT ? 'direction-short' : 'direction-long').click();
await page.getByTestId('collateral-input').fill(COLLATERAL);
// The slider's own units are whole multiples (min=1, max=maxLeverageX), not the
// PRECISION_2 raw the contract takes — the component multiplies by 100 on the way out.
await page.getByTestId('leverage-slider').fill(String(LEVERAGE));
await page.waitForTimeout(500);
console.log(`leverage   ${await page.getByTestId('leverage-value').innerText()}`);
console.log(`order val  ${await page.getByTestId('order-value').innerText()}`);

// --- approval (only when the allowance is short) ---------------------------------------
const approve = page.getByTestId('approve-button');
if (await approve.count()) {
  console.log('approving USDW…');
  await approve.click();
  await approve.waitFor({ state: 'detached', timeout: 120_000 });
  console.log('approved');
}

// --- submit ---------------------------------------------------------------------------
const submit = page.getByTestId('submit-open-button');
await submit.waitFor({ timeout: 30_000 });
if (await submit.isDisabled()) {
  const blocked = await page.getByTestId('open-blocked-degraded').count();
  throw new Error(`submit is disabled (degraded banner: ${blocked > 0})`);
}
await submit.click();
console.log('submitted, waiting for the keeper to fill…');

// The order is a REQUEST; the position exists only once the keeper delivers a signed
// report and the callback runs. Waiting for the banner to resolve is the only honest
// definition of "the trade worked" from the UI's point of view.
const filled = page.getByTestId('order-filled');
const cancelled = page.getByTestId('order-cancelled');
const deadline = Date.now() + 180_000;
let outcome = 'timeout';
while (Date.now() < deadline) {
  if (await filled.count()) { outcome = 'filled'; break; }
  if (await cancelled.count()) { outcome = 'cancelled'; break; }
  await page.waitForTimeout(2000);
}
console.log(`outcome    ${outcome}`);
if (outcome === 'cancelled') console.log(`           ${await cancelled.innerText()}`);

// Positions live under the terminal's Positions tab; make sure it is the visible one
// before the screenshot so the result is actually in frame.
const positionsTab = page.getByRole('button', { name: /positions/i }).first();
if (await positionsTab.count()) await positionsTab.click().catch(() => {});
await page.waitForTimeout(4000);

await page.screenshot({ path: OUT, fullPage: false });
console.log(`screenshot ${OUT}`);

const positionRows = await page.locator('[data-testid^="position-row-"]').count();
console.log(`positions  ${positionRows} row(s) in the table`);
if (positionRows > 0) {
  console.log((await page.locator('[data-testid="positions-table"]').innerText()).replace(/\n+/g, ' | '));
}

console.log(`\ntxs        ${sentTxs.length}`);
for (const t of sentTxs) console.log(`  ${t.hash}`);
console.log(`console errors ${consoleErrors.length}`);
for (const e of consoleErrors.slice(0, 5)) console.log(`  ${e.slice(0, 200)}`);
console.log(`page errors    ${pageErrors.length}`);
for (const e of pageErrors.slice(0, 5)) console.log(`  ${e.slice(0, 200)}`);

await browser.close();
process.exit(outcome === 'filled' ? 0 : 1);
