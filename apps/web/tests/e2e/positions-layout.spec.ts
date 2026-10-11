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
for (const width of [1280, 1366, 1440, 1920]) {
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

    // UPnL — the figure the tab is opened for — is in view without scrolling at any width,
    // and from 1366px the whole row is.
    const content = page.locator('.terminal-tabs .tab-content');
    const upnl = await row.getByTestId('unrealized-pnl').boundingBox();
    const panel = await content.boundingBox();
    expect(upnl!.x + upnl!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
    if (width >= 1366) {
      expect(await content.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    }

    // Close is in reach without scrolling, however wide the table grows.
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

test('the TP/SL and margin control is upright and named', async ({ page, baseURL }) => {
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
  await expect(manage).toHaveAccessibleName('TP/SL and margin');
});

async function openPositionAt(page: import('@playwright/test').Page, baseURL: string | undefined, width: number, height: number) {
  await page.setViewportSize({ width, height });
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
  return row;
}

/** A phone gets each position as a card: nothing scrolls sideways, every figure is named. */
test('on a phone each position is a card that needs no sideways scroll', async ({ page, baseURL }) => {
  const row = await openPositionAt(page, baseURL, 390, 844);
  const content = page.locator('.terminal-tabs .tab-content');

  await expect(page.locator('[data-testid=positions-table] thead')).toBeHidden();
  expect(await content.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  for (const label of ['UPnL', 'Size / Value', 'Entry / Mark', 'Liq. price', 'Margin', 'TP / SL', 'Funding']) {
    await expect(row.locator(`td[data-label="${label}"]`)).toBeVisible();
  }
  const panel = await content.boundingBox();
  const close = await row.getByTestId('close-position-button').boundingBox();
  expect(close!.x + close!.width).toBeLessThanOrEqual(panel!.x + panel!.width);

  // Its TP/SL and margin panel opens at full width, not squeezed into a sliver.
  await row.getByTestId('manage-toggle').click();
  const field = await page.getByTestId('manage-tp-input').boundingBox();
  expect(field!.width).toBeGreaterThan(60);
  expect(field!.x + field!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
});

/** A landscape tablet stacks the terminal, so the table has the full width to itself. */
test('on a landscape tablet the terminal is one column and the row fits', async ({ page, baseURL }) => {
  await openPositionAt(page, baseURL, 1024, 768);
  expect(await page.locator('.terminal-grid').evaluate((el) => getComputedStyle(el).display)).toBe('flex');
  const content = page.locator('.terminal-tabs .tab-content');
  expect(await content.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

/** The close dialog is a centred sheet, not a strip that unrolls at the table's right edge. */
test('Close opens a dialog in the middle of the screen, and a partial close goes through it', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await page.getByTestId('close-position-button').click();

  const dialog = page.getByTestId('close-dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const centre = box!.x + box!.width / 2;
  expect(Math.abs(centre - 720)).toBeLessThan(40);

  await dialog.getByTestId('close-quick-25').click();
  await dialog.getByTestId('close-confirm').click();
  await expect(page.getByTestId('close-pending')).toContainText('Closing…');
  const close = [...state.sentTrading].reverse().find((c) => c.functionName === 'closeTradeMarket');
  expect(close?.args[2]).toBe(2500);
});
