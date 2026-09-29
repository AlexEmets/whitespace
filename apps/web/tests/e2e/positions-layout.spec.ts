import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { TestState } from './testState';

/**
 * The positions table has eleven columns and sits in the terminal's centre column, which
 * is well under 800px on a laptop. Fixed layout at 12% a column squeezed every cell to fit
 * that width regardless of what was in it: values ran into their neighbours and the row's
 * controls spilled over the TP / SL cell. Every cell has to hold its own content, and the
 * table scrolls sideways instead when there is not room for all of them.
 *
 * Layout only exists in a real browser, which is why this is an e2e check.
 */
for (const width of [1280, 1440, 1920]) {
  test(`every positions cell holds its own content at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = new TestState();
    state.positions.push({
      pairIndex: 0, index: 0, buy: true, collateral: '1000000000', leverage: '1000',
      openPrice: state.markPrice, tp: String(70_000n * 10n ** 18n), sl: '0', openedAt: 1_790_000_000, tradeId: '900',
    });
    await installMockWallet(page, state);
    await installMockBackend(page, state, `${baseURL}/__api`);

    await page.goto('/trade');
    await page.getByTestId('connect-wallet-button').click();
    await page.getByTestId('tab-positions').click();
    const row = page.getByTestId('position-row-0-0');
    await expect(row).toBeVisible();

    const overflowing = await row.evaluate((tr) =>
      Array.from((tr as HTMLTableRowElement).cells)
        .filter((td) => td.scrollWidth > td.clientWidth + 1)
        .map((td) => `${td.getAttribute('data-testid') ?? td.cellIndex}: ${td.scrollWidth} > ${td.clientWidth}`),
    );
    expect(overflowing).toEqual([]);

    // Close is in reach without scrolling, however wide the table grows.
    const content = page.locator('.terminal-tabs .tab-content');
    const viewport = await content.boundingBox();
    const controls = await row.locator('.close-control').boundingBox();
    expect(controls!.x).toBeGreaterThanOrEqual(viewport!.x);
    expect(controls!.x + controls!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);

    // Scrolled to the end, TP / SL sits beside the controls rather than under them.
    await content.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const tpsl = await row.getByTestId('position-tpsl').boundingBox();
    const controlsAtEnd = await row.locator('.close-control').boundingBox();
    expect(controlsAtEnd!.x).toBeGreaterThanOrEqual(tpsl!.x + tpsl!.width - 1);

    // Managing from there keeps the fields in view, not off with the scrolled columns.
    await page.getByTestId('manage-toggle').click();
    const field = await page.getByTestId('manage-tp-input').boundingBox();
    const scrolled = await content.boundingBox();
    expect(field!.x).toBeGreaterThanOrEqual(scrolled!.x);
    expect(field!.x + field!.width).toBeLessThanOrEqual(scrolled!.x + scrolled!.width + 1);
  });
}

test('the TP/SL · Margin button reads left to right; only the partial-close chevron turns', async ({ page, baseURL }) => {
  const state = new TestState();
  state.positions.push({
    pairIndex: 0, index: 0, buy: true, collateral: '1000000000', leverage: '1000',
    openPrice: state.markPrice, tp: '0', sl: '0', openedAt: 1_790_000_000, tradeId: '900',
  });
  await installMockWallet(page, state);
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/trade');
  await page.getByTestId('connect-wallet-button').click();
  await page.getByTestId('tab-positions').click();

  const manage = page.getByTestId('manage-toggle');
  await expect(manage).toBeVisible();
  expect(await manage.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  const box = await manage.boundingBox();
  // One line of text: wider than it is tall.
  expect(box!.width).toBeGreaterThan(box!.height);

  const chevron = page.getByTestId('close-partial-toggle');
  expect(await chevron.evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
});
