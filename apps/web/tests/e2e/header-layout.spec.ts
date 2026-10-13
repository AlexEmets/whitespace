import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { TestState } from './testState';

/**
 * The header carries eight links (Terms and Privacy joined the six) beside the chain
 * readout, the theme toggle and a connected wallet. From 901px, where the links come out
 * of the phone menu, everything has to sit on one line without overlapping or pushing the
 * page sideways.
 */
for (const width of [901, 1024, 1100, 1280, 1366, 1440, 1920]) {
  test(`the header fits on one line at ${width}px with a wallet connected`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = new TestState();
    await installMockWallet(page, state);
    await installMockBackend(page, state, `${baseURL}/__api`);
    await page.goto('/docs');
    await page.getByTestId('connect-wallet-button').click();
    await expect(page.getByTestId('wallet-connected')).toBeVisible();
    await expect(page.getByTestId('nav-privacy')).toBeVisible();

    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const nav = await box('#site-nav');
    const right = await box('.nav-right');
    const privacy = await page.getByTestId('nav-privacy').boundingBox();
    const trade = await page.getByTestId('nav-trade').boundingBox();

    // The links run left to right on one row and end before the controls begin.
    expect(Math.abs(privacy!.y - trade!.y)).toBeLessThan(2);
    expect(privacy!.x + privacy!.width).toBeLessThanOrEqual(right.x);
    expect(nav.x + nav.width).toBeLessThanOrEqual(right.x + 1);
    // Nothing spills off the right edge or makes the page scroll sideways.
    expect(right.x + right.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}

test('on a phone Terms and Privacy are in the menu', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMockBackend(page, new TestState(), `${baseURL}/__api`);
  await page.goto('/');
  await page.getByTestId('menu-button').click();
  await expect(page.getByTestId('nav-terms')).toBeVisible();
  await expect(page.getByTestId('nav-privacy')).toBeVisible();
  await page.getByTestId('nav-terms').click();
  await page.waitForURL('**/terms', { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of Use');
});
