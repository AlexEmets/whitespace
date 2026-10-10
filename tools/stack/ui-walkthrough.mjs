/**
 * A manual walkthrough of the trading terminal, run by a headless browser against a LOCAL
 * stack (tools/stack/acceptance-anvil.sh up): the real Next app, the real contracts on anvil,
 * the real keeper and bots. A Node-held key answers the page's wallet requests, the way
 * drive-trade.mjs does for the public testnet; the key never enters the page.
 *
 * It does what a trader does, through the UI only, and checks what a trader would see:
 * market open and close, limit and stop entries, TP/SL set at open and triggered by the bots,
 * a liquidation, position management, the vault, and one-click trading end to end (every
 * one-click step asserts the wallet was asked to sign nothing).
 *
 * Price moves come from the stack's own `shift` hook (shifted-publisher.mjs), which only runs
 * against anvil.
 *
 *   UI_RPC=http://127.0.0.1:8547 UI_URL=http://127.0.0.1:3100/trade UI_API=http://127.0.0.1:4100 \
 *   UI_KEY=/path/trader.json UI_HOOKS=tools/stack/acceptance-anvil.sh UI_OUT=/tmp/ui \
 *     node tools/stack/ui-walkthrough.mjs
 *
 * Exit code 0 only when every step passed. Screenshots of failures land in UI_OUT.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createWalletClient, defineChain, http } from '../../apps/web/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../../apps/web/node_modules/viem/_esm/accounts/index.js';
import { chromium } from '../../apps/web/node_modules/@playwright/test/index.mjs';

const env = process.env;
const RPC = env.UI_RPC ?? 'http://127.0.0.1:8547';
const URL = env.UI_URL ?? 'http://127.0.0.1:3100/trade';
const API = env.UI_API ?? 'http://127.0.0.1:4100';
const HOOKS = env.UI_HOOKS;
const OUT = env.UI_OUT ?? '/tmp/ui-walkthrough';
const ONLY = env.UI_ONLY ? new Set(env.UI_ONLY.split(',')) : null;
mkdirSync(OUT, { recursive: true });

const chain = defineChain({ id: 1874, name: 'local', nativeCurrency: { name: 'W', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const raw = JSON.parse(readFileSync(env.UI_KEY, 'utf8'));
const account = privateKeyToAccount((Array.isArray(raw) ? raw[0] : raw).private_key);
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }) });
  const b = await res.json();
  if (b.error) throw Object.assign(new Error(b.error.message), { data: b.error.data });
  return b.result;
}

/** Every transaction the page asked the WALLET to sign. One-click steps assert this does not grow. */
const walletTxs = [];
async function handle(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [account.address];
    case 'eth_chainId':
      return '0x752';
    case 'net_version':
      return '1874';
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
      return null;
    case 'wallet_getPermissions':
    case 'wallet_requestPermissions':
      return [{ parentCapability: 'eth_accounts' }];
    case 'eth_sendTransaction': {
      const tx = params[0];
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
      walletTxs.push({ to: tx.to, sel: tx.data?.slice(0, 10) ?? 'value', hash });
      return hash;
    }
    default:
      return rpc(method, params);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await context.exposeFunction('__walletRequest', async (method, params) => {
  try {
    return { ok: true, result: await handle(method, params) };
  } catch (err) {
    return { ok: false, error: { code: -32603, message: err.message, data: err.data } };
  }
});
await context.addInitScript(() => {
  const listeners = new Map();
  const provider = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      const r = await window.__walletRequest(method, params ?? []);
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data });
      return r.result;
    },
    on: (e, h) => (listeners.has(e) || listeners.set(e, new Set()), listeners.get(e).add(h), provider),
    removeListener: (e, h) => (listeners.get(e)?.delete(h), provider),
  };
  Object.defineProperty(window, 'ethereum', { value: provider, configurable: true });
  const detail = Object.freeze({ info: { uuid: '00000000-0000-4000-8000-000000000009', name: 'Walkthrough', icon: 'data:image/svg+xml,<svg/>', rdns: 'dev.whitespace.walkthrough' }, provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
});

const results = [];
async function step(id, name, fn) {
  if (ONLY && !ONLY.has(id)) return;
  const t = Date.now();
  try {
    const note = await fn();
    results.push({ id, name, ok: true, s: Math.round((Date.now() - t) / 1000), note: note ?? '' });
    console.log(`PASS ${id.padEnd(12)} ${name}${note ? ` — ${note}` : ''}`);
  } catch (err) {
    results.push({ id, name, ok: false, note: err.message.split('\n')[0] });
    console.log(`FAIL ${id.padEnd(12)} ${name} — ${err.message.split('\n')[0]}`);
    await page.screenshot({ path: `${OUT}/fail-${id}.png`, fullPage: true }).catch(() => {});
    // Leave the page where the next step expects it, so one failure does not cascade.
    await page.getByTestId('tab-positions').click({ timeout: 5000 }).catch(() => {});
    await page.getByTestId('order-kind-market').click({ timeout: 5000 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------
// Helpers: everything below goes through the page, never around it
// ---------------------------------------------------------------------------------------

function shift(feed, bps) {
  if (!HOOKS) throw new Error('UI_HOOKS is not set: price-moving steps need the stack hook');
  execFileSync(HOOKS, bps === 0 ? ['unshift'] : ['shift', feed, String(bps)], { stdio: 'ignore', env });
}
async function markNow() {
  return Number((await page.getByTestId('mark-price').first().innerText()).replace(/[^0-9.]/g, ''));
}
const rows = () => page.locator('[data-testid^="position-row-"]');
async function waitRows(pred, ms = 120_000) {
  const t = Date.now();
  for (;;) {
    const n = await rows().count();
    if (pred(n)) return n;
    if (Date.now() - t > ms) throw new Error(`positions count stuck at ${n}`);
    await page.waitForTimeout(1000);
  }
}
async function lastCloseReason() {
  const r = await (await fetch(`${API}/positions/${account.address}/history`)).json();
  return r[0]?.closeReason;
}
/** Waits for `okId`, or fails with whatever error the order form is showing instead. */
async function submitAndExpect(okId) {
  await page.getByTestId('submit-open-button').click();
  const ok = page.getByTestId(okId);
  const err = page.getByTestId('open-error');
  await ok.or(err).first().waitFor({ timeout: 90_000 });
  if (await err.count()) throw new Error(`order form: ${await err.innerText()}`);
}
async function waitSubmitEnabled() {
  await page.waitForFunction(() => !document.querySelector('[data-testid="submit-open-button"]')?.disabled, null, { timeout: 60_000 });
}
async function marketOpen(size) {
  await page.getByTestId('order-kind-market').click();
  await page.getByTestId('size-input').fill(size);
  await waitSubmitEnabled();
  await submitAndExpect('order-pending-banner');
  await page.getByTestId('order-filled').waitFor({ timeout: 60_000 });
}
async function openWithTpSl(size, tp, sl) {
  await page.getByTestId('order-kind-market').click();
  const box = page.getByTestId('tpsl-toggle');
  if (!(await box.isChecked())) await box.check();
  await page.getByTestId('tp-input').fill(tp ? String(tp) : '');
  await page.getByTestId('sl-input').fill(sl ? String(sl) : '');
  await marketOpen(size);
  await box.uncheck();
}
async function closeFirst(quick) {
  const n = await rows().count();
  await rows().first().getByTestId('close-position-button').click();
  if (quick) await page.getByTestId(`close-quick-${quick}`).click();
  await page.getByTestId('close-confirm').click();
  if (!quick) await waitRows((k) => k < n, 90_000);
}
/** Cancels every resting order through the Open orders tab, one at a time, each confirmed gone. */
async function cancelAllRestingOrders() {
  await page.getByTestId('tab-orders').click();
  const resting = () => page.locator('[data-testid^="limit-order-row-"]');
  for (let guard = 0; guard < 20 && (await resting().count()) > 0; guard++) {
    const n = await resting().count();
    await resting().first().locator('[data-testid^="limit-cancel-"]').click();
    const t = Date.now();
    while ((await resting().count()) >= n && Date.now() - t < 45_000) await page.waitForTimeout(1000);
  }
  if ((await resting().count()) > 0) throw new Error('resting orders would not cancel');
  await page.getByTestId('tab-positions').click();
}
/** Closes every open position, so each run starts from the same empty account. */
async function closeAllPositions() {
  for (let guard = 0; guard < 20 && (await rows().count()) > 0; guard++) await closeFirst();
}

/** Lets a shifted price settle back to the real market before the next step reads it. */
const settle = () => page.waitForTimeout(15_000);

// ---------------------------------------------------------------------------------------
// The walkthrough
// ---------------------------------------------------------------------------------------

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

await step('connect', 'connect the wallet', async () => {
  await page.waitForTimeout(2000);
  const btn = page.getByTestId('connect-wallet-button');
  if (await btn.count()) await btn.click();
  await page.getByTestId('wallet-connected').waitFor({ timeout: 60_000 });
});

await step('clean', 'start from an empty account (close leftovers, cancel resting orders)', async () => {
  await page.getByTestId('tab-positions').click();
  await closeAllPositions();
  await cancelAllRestingOrders();
});

await step('market', 'market open and close, signed by the wallet', async () => {
  const n = await rows().count();
  await marketOpen('0.001');
  await waitRows((k) => k > n, 60_000);
  await closeFirst();
  return `${walletTxs.length} wallet tx(s) so far`;
});

await step('limit', 'limit buy below and stop buy above the market: placed, listed, cancelled', async () => {
  for (const [kind, factor] of [['limit', 0.9], ['stop', 1.1]]) {
    await page.getByTestId(`order-kind-${kind}`).click();
    await page.getByTestId('trigger-price-input').fill(String(Math.round((await markNow()) * factor)));
    await page.getByTestId('size-input').fill('0.001');
    await waitSubmitEnabled();
    await submitAndExpect('order-placed');
  }
  await page.getByTestId('tab-orders').click();
  await page.locator('[data-testid^="limit-order-row-"]').nth(1).waitFor({ timeout: 60_000 });
  await cancelAllRestingOrders();
});

await step('manage', 'add margin, set a take profit, close', async () => {
  const n = await rows().count();
  await marketOpen('0.001');
  await waitRows((k) => k > n, 60_000);
  await rows().first().getByTestId('manage-toggle').click();
  await page.getByTestId('manage-margin-input').fill('5');
  await page.getByTestId('manage-margin-add').click();
  await page.getByTestId('manage-message').filter({ hasText: 'Margin added' }).waitFor({ timeout: 60_000 });
  await page.getByTestId('manage-tp-input').fill(String(Math.round((await markNow()) * 1.2)));
  await page.getByTestId('manage-tp-save').click();
  await page.getByTestId('manage-message').filter({ hasText: 'Take profit updated' }).waitFor({ timeout: 60_000 });
  await closeFirst();
});

await step('tpsl-open', 'open with TP and SL from the form; both show on the position', async () => {
  const m = await markNow();
  const n = await rows().count();
  await openWithTpSl('0.001', Math.round(m * 1.02), Math.round(m * 0.97));
  await waitRows((k) => k > n, 60_000);
  const cell = (await page.getByTestId('position-tpsl').first().innerText()).replace(/\s+/g, ' ');
  if (!/\d.*\/.*\d/.test(cell)) throw new Error(`TP/SL cell reads "${cell}"`);
  return cell;
});

await step('sl', 'the bots fire the stop loss on a -4% move; history says SL', async () => {
  const n = await rows().count();
  shift('BTC/USD', -400);
  try {
    await waitRows((k) => k < n, 150_000);
  } finally {
    shift('BTC/USD', 0);
  }
  await page.waitForTimeout(8000);
  const r = await lastCloseReason();
  if (r !== 'sl') throw new Error(`close reason ${r}`);
});

await step('tp', 'the bots fire the take profit on a +3% move; history says TP', async () => {
  await settle();
  const n = await rows().count();
  await openWithTpSl('0.001', Math.round((await markNow()) * 1.015), null);
  await waitRows((k) => k > n, 60_000);
  shift('BTC/USD', 300);
  try {
    await waitRows((k) => k <= n, 150_000);
  } finally {
    shift('BTC/USD', 0);
  }
  await page.waitForTimeout(8000);
  const r = await lastCloseReason();
  if (r !== 'tp') throw new Error(`close reason ${r}`);
});

await step('liq', 'a 100x long is liquidated by the bots on a -2% move', async () => {
  await settle();
  await page.getByTestId('leverage-slider').fill('100');
  const n = await rows().count();
  await marketOpen('0.002');
  await waitRows((k) => k > n, 60_000);
  await page.getByTestId('leverage-slider').fill('10');
  shift('BTC/USD', -200);
  try {
    await waitRows((k) => k <= n, 180_000);
  } finally {
    shift('BTC/USD', 0);
  }
  await page.waitForTimeout(8000);
  return `close reason ${await lastCloseReason()}`;
});

await step('vault', 'vault: request a deposit, find it again after a reload, cancel it', async () => {
  await page.getByTestId('nav-vaults').click();
  await page.waitForURL('**/vaults', { timeout: 60_000 });
  await page.locator('[data-testid$="-deposit-button"]').first().click();
  await page.getByTestId('funding-amount-input').fill('100');
  await page.getByTestId('funding-request').click();
  await page.getByTestId('funding-settlement-status').filter({ hasText: 'PENDING' }).waitFor({ timeout: 60_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid$="-deposit-button"]').first().click();
  await page.getByTestId('funding-cancel').click({ timeout: 60_000 });
  await page.getByTestId('funding-message').filter({ hasText: 'cancelled' }).waitFor({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await page.getByTestId('nav-trade').click();
  await page.waitForURL('**/trade', { timeout: 60_000 });
});

await step('oc-enable', 'enable one-click: setDelegate and a gas top-up, then ready', async () => {
  await settle();
  const n = walletTxs.length;
  await page.getByTestId('one-click-enable').click();
  await page.waitForFunction(() => /on/i.test(document.querySelector('[data-testid="one-click-status"]')?.textContent ?? ''), null, { timeout: 60_000 });
  await page.waitForFunction(() => /[1-9]/.test(document.querySelector('[data-testid="one-click-gas"]')?.textContent ?? ''), null, { timeout: 60_000 });
  return `${walletTxs.length - n} wallet tx(s)`;
});

await step('oc-trade', 'one-click: open with TP/SL, move the SL, remove margin, close half, close — no wallet tx', async () => {
  const before = walletTxs.length;
  const m = await markNow();
  const n = await rows().count();
  await openWithTpSl('0.002', Math.round(m * 1.05), Math.round(m * 0.96));
  await waitRows((k) => k > n, 60_000);
  await rows().first().getByTestId('manage-toggle').click();
  await page.getByTestId('manage-sl-input').fill(String(Math.round(m * 0.97)));
  await page.getByTestId('manage-sl-save').click();
  await page.getByTestId('manage-message').filter({ hasText: 'Stop loss updated' }).waitFor({ timeout: 60_000 });
  await page.getByTestId('manage-margin-input').fill('1');
  await page.getByTestId('manage-margin-remove').click();
  await page.getByTestId('manage-message').filter({ hasText: 'Removal requested' }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(10_000); // the removal is applied by a keeper report
  await closeFirst(50);
  await page.waitForTimeout(12_000);
  if ((await rows().count()) < 1) throw new Error('a 50% close removed the whole position');
  await closeFirst();
  if (walletTxs.length !== before) throw new Error(`the wallet was asked to sign ${walletTxs.length - before} tx(s)`);
});

await step('oc-orders', 'one-click: limit and stop placed and cancelled — no wallet tx', async () => {
  const before = walletTxs.length;
  for (const [kind, factor] of [['limit', 0.9], ['stop', 1.1]]) {
    await page.getByTestId(`order-kind-${kind}`).click();
    await page.getByTestId('trigger-price-input').fill(String(Math.round((await markNow()) * factor)));
    await page.getByTestId('size-input').fill('0.001');
    await waitSubmitEnabled();
    await submitAndExpect('order-placed');
  }
  await page.getByTestId('tab-orders').click();
  await page.locator('[data-testid^="limit-order-row-"]').nth(1).waitFor({ timeout: 60_000 });
  await cancelAllRestingOrders();
  await page.getByTestId('order-kind-market').click();
  if (walletTxs.length !== before) throw new Error(`the wallet was asked to sign ${walletTxs.length - before} tx(s)`);
});

await step('oc-reload', 'one-click survives a reload', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /on/i.test(document.querySelector('[data-testid="one-click-status"]')?.textContent ?? ''), null, { timeout: 60_000 });
});

await step('oc-disable', 'turn one-click off', async () => {
  await page.getByTestId('one-click-disable').click();
  await page.getByTestId('one-click-enable').waitFor({ timeout: 60_000 });
});

await page.screenshot({ path: `${OUT}/final.png`, fullPage: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length} step(s): ${results.length - failed} PASS, ${failed} FAIL; wallet txs ${walletTxs.length}; page errors ${pageErrors.length}`);
for (const e of pageErrors.slice(0, 5)) console.log(`  page error: ${e}`);
await browser.close();
process.exit(failed === 0 && pageErrors.length === 0 ? 0 : 1);
