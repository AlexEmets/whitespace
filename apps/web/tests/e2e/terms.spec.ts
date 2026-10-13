import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { TestState } from './testState';

/**
 * Agreement to the Terms is asked for on a wallet's first connect, before the setup guide,
 * and the only ways past it are agreeing or disconnecting.
 */

test('a first connect asks for the Terms before the setup guide, and only once', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const state = new TestState();
  state.wbtBalance = 0n;
  state.usdwBalance = 0n;
  await installMockWallet(page, state, { startsUnauthorized: true, termsAccepted: false });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('connect-wallet-button').click();

  const gate = page.getByTestId('terms-gate');
  await expect(gate).toBeVisible({ timeout: 15_000 });
  // The setup guide waits its turn.
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId('get-started')).not.toBeVisible();

  await expect(page.getByTestId('terms-gate-agree')).toBeDisabled();
  await page.getByTestId('terms-gate-checkbox').check();
  await page.getByTestId('terms-gate-agree').click();

  await expect(gate).not.toBeVisible();
  await expect(page.getByTestId('get-started')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('get-started-close').click();

  await page.reload();
  const connect = page.getByTestId('connect-wallet-button');
  const connected = page.getByTestId('wallet-connected');
  await expect(connect.or(connected)).toBeVisible({ timeout: 15_000 });
  if (await connect.isVisible()) await connect.click();
  await expect(connected).toBeVisible();
  await page.waitForTimeout(1_500);
  await expect(gate).not.toBeVisible();
});

test('declining the Terms disconnects the wallet', async ({ page, baseURL }) => {
  const state = new TestState();
  await installMockWallet(page, state, { startsUnauthorized: true, termsAccepted: false });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('connect-wallet-button').click();
  await expect(page.getByTestId('terms-gate')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('terms-gate-decline').click();

  await expect(page.getByTestId('terms-gate')).not.toBeVisible();
  await expect(page.getByTestId('connect-wallet-button')).toBeVisible();
  await expect(page.getByTestId('wallet-connected')).toHaveCount(0);
});

test('the landing page links the Terms and the Privacy Policy', async ({ page, baseURL }) => {
  const state = new TestState();
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('footer-terms').click();
  await page.waitForURL('**/terms', { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of Use');
  await expect(page.getByTestId('terms-eligibility')).toContainText('the United States of America');

  await page.goto('/');
  await page.getByTestId('footer-privacy').click();
  await page.waitForURL('**/privacy', { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy');
});
