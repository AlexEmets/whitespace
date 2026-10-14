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

test('the landing page states points honestly and links the Terms and the Privacy Policy', async ({ page, baseURL }) => {
  const state = new TestState();
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/');
  // Season One is live: the landing page used to call points "not live yet".
  await expect(page.getByTestId('landing-points-title')).toHaveText('Live, and worth nothing.');
  await expect(page.getByText('Not live yet.')).toHaveCount(0);
  await expect(page.getByTestId('landing-points-body').locator('a[href="/terms"]')).toBeVisible();

  await page.getByTestId('footer-terms').click();
  await page.waitForURL('**/terms', { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of Use');
  await expect(page.getByTestId('terms-eligibility')).toContainText('the United States of America');

  await page.goto('/');
  await page.getByTestId('footer-privacy').click();
  await page.waitForURL('**/privacy', { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy');
});

test('the landing page links the community: announcements, chats, X and the bug form', async ({ page, baseURL }) => {
  await installMockBackend(page, new TestState(), `${baseURL}/__api`);
  await page.goto('/');
  const block = page.getByTestId('landing-community');
  await block.scrollIntoViewIfNeeded();
  await expect(block).toBeVisible();
  const hrefs = await block.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(hrefs).toEqual([
    'https://t.me/WhiteSpaceAnnouncementsEN',
    'https://t.me/WhiteSpaceAnnouncementsUA',
    'https://t.me/WhiteSpaceEN',
    'https://t.me/WhiteSpaceUA',
    'https://x.com/WhiteSpaceFi',
    'https://forms.gle/NPronWQVVFu5MSnt9',
  ]);
  await expect(page.getByTestId('footer-x')).toHaveAttribute('href', 'https://x.com/WhiteSpaceFi');
  await expect(page.getByTestId('footer-telegram')).toHaveAttribute('href', 'https://t.me/WhiteSpaceAnnouncementsEN');
});

/** With X and Telegram added the footer row outgrew a phone and pushed "Telegram" off-screen. */
test('on a phone the footer links wrap instead of running off the edge', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMockBackend(page, new TestState(), `${baseURL}/__api`);
  await page.goto('/');
  const telegram = page.getByTestId('footer-telegram');
  await telegram.scrollIntoViewIfNeeded();
  const box = await telegram.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
