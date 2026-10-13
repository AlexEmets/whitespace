import { expect, test, type Page } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { TestState } from './testState';

/**
 * iOS Safari zooms the page when a field under 16px takes focus, and a zoomed trading
 * ticket has to be pinched back by hand. globals.css raises every field to 16px on touch
 * screens — but the panels size their fields in CSS modules, whose class selectors outrank
 * a bare `input`, so on a phone (where the root font is 13px) the ticket's TP/SL, the close
 * amount and the vault deposit stayed at 11.7–13.65px and zoomed on every tap.
 */

async function smallFields(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const type = (el as HTMLInputElement).type;
        return r.width > 0 && r.height > 0 && !['checkbox', 'radio', 'range', 'hidden'].includes(type);
      })
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.dataset.testid ?? el.tagName}: ${getComputedStyle(el).fontSize}`),
  );
}

async function terminalWithPosition(page: Page, baseURL: string | undefined) {
  const state = new TestState();
  state.positions.push({
    pairIndex: 0, index: 0, buy: true, collateral: '1000000000', leverage: '1000',
    openPrice: state.markPrice, tp: '0', sl: '0', openedAt: 1_790_000_000, tradeId: '900',
  });
  await installMockWallet(page, state);
  await installMockBackend(page, state, `${baseURL}/__api`);
  await page.goto('/trade');
  await page.getByTestId('connect-wallet-button').click();
  await expect(page.getByTestId('wallet-connected')).toBeVisible();
}

test.describe('on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('every field in the ticket is at least 16px, so focusing one does not zoom the page', async ({ page, baseURL }) => {
    await terminalWithPosition(page, baseURL);

    await page.getByTestId('tpsl-toggle').check();
    await page.getByTestId('max-slippage').click();
    await expect(page.getByTestId('tp-input')).toBeVisible();
    await expect(page.getByTestId('max-slippage-input')).toBeVisible();
    expect(await smallFields(page)).toEqual([]);

    await page.getByTestId('order-kind-limit').click();
    await expect(page.getByTestId('trigger-price-input')).toBeVisible();
    expect(await smallFields(page)).toEqual([]);
  });

  test('the close dialog and the position manager are at least 16px too', async ({ page, baseURL }) => {
    await terminalWithPosition(page, baseURL);
    await page.getByTestId('tab-positions').click();
    const row = page.getByTestId('position-row-0-0');

    await row.getByTestId('close-position-button').click();
    await expect(page.getByTestId('close-amount-input')).toBeVisible();
    expect(await smallFields(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await row.getByTestId('manage-toggle').click();
    await expect(page.getByTestId('manage-tp-input')).toBeVisible();
    expect(await smallFields(page)).toEqual([]);
  });

  test('the vault deposit is at least 16px', async ({ page, baseURL }) => {
    await terminalWithPosition(page, baseURL);
    await page.getByTestId('menu-button').click();
    await page.getByTestId('nav-vaults').click();
    await page.waitForURL('**/vaults', { timeout: 30_000 });
    await page.getByTestId('vault-deposit-button').click();
    await expect(page.getByTestId('funding-amount-input')).toBeVisible();
    expect(await smallFields(page)).toEqual([]);
  });
});

/** The bump is for touch screens only: a mouse-driven desktop keeps the compact ticket. */
test('on a desktop the ticket keeps its compact fields', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await terminalWithPosition(page, baseURL);
  await page.getByTestId('tpsl-toggle').check();
  const size = await page.getByTestId('tp-input').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeLessThan(16);
});
