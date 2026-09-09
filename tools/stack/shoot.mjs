/**
 * Loads pages of the running web app in a real browser, captures a screenshot, and
 * reports what actually rendered plus any console/page errors.
 *
 * Exists because a `curl` of a Next.js page proves almost nothing here: every live value
 * in this UI arrives client-side (`useEffect` + polling in `src/hooks/*`), so the
 * server-rendered HTML contains none of it. "The page returned 200" and "the page shows a
 * price" are entirely different claims, and only the second one is worth making.
 *
 * Usage:
 *   node tools/stack/shoot.mjs http://127.0.0.1:3100/trade /tmp/trade.png [selector...]
 */

// Via `@playwright/test` rather than `playwright`: only the former is a direct dependency
// of apps/web, so only the former is guaranteed to be linked into its node_modules. The
// bare `playwright` package exists in the pnpm store as a transitive dependency, and
// reaching into the store by version-stamped path would break on the next bump.
import { chromium } from '../../apps/web/node_modules/@playwright/test/index.mjs';

const [url, out, ...selectors] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: shoot.mjs <url> <out.png> [selector...]');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// Collected rather than printed as they arrive, so the report reads as one block. A
// pageerror here is a genuine defect: the e2e suite already asserts zero of them.
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
// The hooks poll on a 3-5s cadence; one full cycle past network-idle is enough for the
// first payload to have landed and rendered.
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
