import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { MOCK_TRADER_ADDRESS, TestState } from './testState';

/**
 * The first thing a brand-new tester needs is gas, and nothing used to say so: their
 * wallet connected to a terminal it could not sign a single transaction on, and the WBT
 * faucet was one nav link among six. The setup dialog (components/GetStarted.tsx) now
 * meets a wallet short of gas or margin on its first connect.
 *
 * This drives that from the landing page through both claims in a real browser — the
 * WBT one through the API mock, the USDW one through the wallet — and then checks the
 * dialog is a one-time greeting, not a nag on every visit.
 */

test('a new wallet is walked through gas and margin on its first connect, and only then', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const state = new TestState();
  state.wbtBalance = 0n;
  state.usdwBalance = 0n;
  await installMockWallet(page, state, { startsUnauthorized: true });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('connect-wallet-button').click();

  const dialog = page.getByTestId('get-started');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('get-started-wbt-balance')).toHaveText('In your wallet: 0.0000 WBT');
  // Nothing to sign the USDW claim with yet.
  await expect(page.getByTestId('get-started-claim-usdw')).toBeDisabled();

  await page.getByTestId('get-started-claim-wbt').click();
  await expect(page.getByTestId('get-started-wbt-success')).toBeVisible();
  expect(state.wbtFaucetClaims).toEqual([MOCK_TRADER_ADDRESS.toLowerCase()]);
  // The balance poll sees the gas land and closes the step.
  await expect(page.getByTestId('get-started-gas')).toHaveAttribute('data-done', 'true', { timeout: 10_000 });

  await page.getByTestId('get-started-claim-usdw').click();
  await expect(page.getByTestId('get-started-usdw')).toHaveAttribute('data-done', 'true', { timeout: 10_000 });
  await expect(page.getByTestId('get-started-usdw-balance')).toHaveText('In your wallet: 1,000.00 USDW');

  await page.getByTestId('get-started-trade').click();
  await page.waitForURL('**/trade', { timeout: 30_000 });
  await expect(dialog).not.toBeVisible();

  // Drain the wallet again and come back: this browser has greeted this address already.
  state.wbtBalance = 0n;
  state.usdwBalance = 0n;
  await page.reload();
  // The mock wallet forgets its authorisation on reload, as an extension may; reconnect
  // if the app did not do it by itself.
  const connect = page.getByTestId('connect-wallet-button');
  const connected = page.getByTestId('wallet-connected');
  await expect(connect.or(connected)).toBeVisible({ timeout: 15_000 });
  if (await connect.isVisible()) await connect.click();
  await expect(connected).toBeVisible();
  // Long enough for both balance reads to land and the dialog to have decided.
  await page.waitForTimeout(2_000);
  await expect(dialog).not.toBeVisible();
});

test('a wallet that already has gas and margin is not interrupted', async ({ page, baseURL }) => {
  const state = new TestState();
  await installMockWallet(page, state, { startsUnauthorized: true });
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  await page.getByTestId('connect-wallet-button').click();
  await expect(page.getByTestId('wallet-connected')).toBeVisible();
  // Long enough for both balance reads to land and the dialog to have decided.
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId('get-started')).not.toBeVisible();
});
