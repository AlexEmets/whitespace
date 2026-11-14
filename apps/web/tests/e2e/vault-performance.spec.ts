import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { TestState } from './testState';

const performance: unknown = JSON.parse(readFileSync(new URL('./vaultPerformance.fixture.json', import.meta.url), 'utf8'));

/**
 * /vaults shows what an LP has earned. The fixture is GET /vault/performance computed from
 * the live testnet vault's settlements (393 of them, 28 Sep – 14 Nov 2026), so the figures
 * asserted here are ones a visitor really saw.
 */

test('/vaults: shows the APRs, the return since launch and the share price history', async ({ page, baseURL }) => {
  const state = new TestState();
  state.vaultPerformance = performance;
  await installMockBackend(page, state, `${baseURL}/__api`);
  await page.goto('/vaults');

  await expect(page.getByTestId('vault-apr-7d')).toContainText('+0.61%', { timeout: 30_000 });
  await expect(page.getByTestId('vault-apr-30d')).toContainText('+0.86%');
  await expect(page.getByTestId('vault-since-launch')).toContainText('+0.19%');
  await expect(page.getByTestId('vault-since-launch')).toContainText('+1.45% APR since 28 Sep 2026');
  await expect(page.getByTestId('vault-share-price')).toContainText('1.0019');
  await expect(page.getByTestId('vault-chart').locator('path')).toHaveCount(2);
});

test('/vaults: before the vault has settled, every figure is a dash with its reason', async ({ page, baseURL }) => {
  await installMockBackend(page, new TestState(), `${baseURL}/__api`);
  await page.goto('/vaults');

  const apr = page.getByTestId('vault-apr-7d');
  await expect(apr.getByTestId('honest-dash')).toHaveAttribute('title', /could not be loaded/, { timeout: 30_000 });
  await expect(page.getByTestId('vault-chart')).toHaveCount(0);
});

test('/vaults: on a phone the performance block fits the screen', async ({ page, baseURL }) => {
  const state = new TestState();
  state.vaultPerformance = performance;
  await installMockBackend(page, state, `${baseURL}/__api`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vaults');
  await expect(page.getByTestId('vault-chart')).toBeVisible({ timeout: 30_000 });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
