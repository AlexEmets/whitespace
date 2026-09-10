/**
 * Like `shoot.mjs`, but with a real wallet connected.
 *
 * Most of this product only exists once an address is connected: portfolio balances, open
 * positions, the order form's size and liquidation estimates, the faucet. A plain
 * screenshot of a headless browser shows none of it — every page renders its
 * "no wallet connected" branch, which is a real state worth checking but is not the
 * product. This makes the other half observable.
 *
 * Usage:
 *   node tools/stack/shoot-wallet.mjs http://127.0.0.1:3100/portfolio /tmp/p.png [selector...]
 *   node tools/stack/shoot-wallet.mjs --key ~/.whitespace-keys/dev.json <url> <out> [selector...]
 */

import { chromium } from '../../apps/web/node_modules/@playwright/test/index.mjs';
import { createWalletHarness } from './wallet.mjs';

const argv = process.argv.slice(2);
const keyFlag = argv.indexOf('--key');
const keyPath = keyFlag === -1 ? undefined : argv[keyFlag + 1];
// Guarded on `keyFlag !== -1`: with the flag absent it is -1, and `keyFlag + 1` is 0 —
// which silently swallowed the first positional argument, i.e. the url.
const positional = argv.filter(
  (a, i) => !(keyFlag !== -1 && (i === keyFlag || i === keyFlag + 1)) && !a.startsWith('--'),
);
const [url, out, ...selectors] = positional;

if (!url || !out) {
  console.error('usage: shoot-wallet.mjs [--key <path>] <url> <out.png> [selector...]');
  process.exit(2);
}

const harness = createWalletHarness({ keyPath });
console.log(`wallet     ${harness.account.address}`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
const pageErrors = [];
await harness.attach(context, (line) => console.log(`  ${line}`));

const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });

// wagmi reconnects on mount and this provider answers `eth_accounts` immediately, so the
// app is usually connected before the first frame. Waiting on the header chip rather than
// a fixed sleep makes the screenshot deterministic.
await page
  .getByTestId('wallet-connected')
  .waitFor({ timeout: 30_000 })
  .catch(() => console.log('  (wallet never reported connected — capturing anyway)'));
// One full polling cycle past network-idle, so the first live payload has landed.
await page.waitForTimeout(6000);

await page.screenshot({ path: out, fullPage: true });

console.log(`url        ${url}`);
console.log(`title      ${await page.title()}`);
console.log(`screenshot ${out}`);

for (const selector of selectors) {
  const found = await page.locator(selector).count();
  if (found === 0) {
    console.log(`MISSING    ${selector}`);
    continue;
  }
  const texts = await page.locator(selector).allInnerTexts();
  console.log(`${String(found).padStart(2)}x ${selector}\n    ${texts.slice(0, 6).join('\n    ').replace(/\n\s*\n/g, '\n')}`);
}

console.log(`\nconsole errors ${consoleErrors.length}`);
for (const e of consoleErrors.slice(0, 8)) console.log(`  ${e.slice(0, 200)}`);
console.log(`page errors    ${pageErrors.length}`);
for (const e of pageErrors.slice(0, 8)) console.log(`  ${e.slice(0, 200)}`);

await browser.close();
process.exit(pageErrors.length > 0 ? 1 : 0);
