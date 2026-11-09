import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { TestState } from './testState';

/**
 * /docs/api in a real browser: reachable from /docs, "Try it" round-trips through the
 * app's own API client path, and the page holds a phone's width — code blocks and long
 * paths scroll inside their own boxes instead of widening the page.
 */

test('/docs links to the API reference, and "Try it" shows the live response', async ({ page, baseURL }) => {
  await installMockBackend(page, new TestState(), `${baseURL}/__api`);
  await page.goto('/docs');
  await page.getByTestId('docs-api-link').click();
  await expect(page).toHaveURL(/\/docs\/api$/);
  await expect(page.getByRole('heading', { name: 'Whitespace API' })).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('try-/health').click();
  const out = page.getByTestId('response-/health');
  await expect(out).toContainText('200');
  await expect(out).toContainText('"status": "ok"');
});

test('/docs/api: on a phone nothing runs off the side of the page', async ({ page, baseURL }) => {
  await installMockBackend(page, new TestState(), `${baseURL}/__api`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/docs/api');
  await expect(page.getByTestId('endpoint-/positions/:address/history')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('try-/markets').click();
  await expect(page.getByTestId('response-/markets')).toContainText('"from"');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
