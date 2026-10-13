import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { TestState } from './testState';

/**
 * The chart is handled the way TradingView is. It used to open on all the history it had
 * loaded (two days, fixed), so there was nothing to drag back into; the price axis could
 * not be touched at all. These drive the real pointer and wheel in a browser.
 */

async function openChart(page: Page, baseURL: string | undefined, around?: number): Promise<Locator> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = new TestState();
  // Three thousand one-minute bars exist; the chart loads a thousand at a time.
  state.chartHistory = { start: Math.floor(Date.now() / 1000) - 3000 * 60, base: around };
  if (around !== undefined) state.markPrice = (BigInt(around + 1) * 10n ** 18n).toString();
  await installMockBackend(page, state, `${baseURL}/__api`);
  await page.goto('/trade');
  const svg = page.getByTestId('price-svg');
  await expect(svg).toBeVisible({ timeout: 30_000 });
  await expect(svg).toHaveAttribute('data-total-candles', /\d{3,}/);
  return svg;
}

const num = async (svg: Locator, attr: string) => Number(await svg.getAttribute(attr));
const big = async (svg: Locator, attr: string) => BigInt((await svg.getAttribute(attr)) ?? '0');

async function plotPoint(svg: Locator) {
  const box = (await svg.boundingBox())!;
  return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.45, box };
}

async function priceAxisPoint(svg: Locator) {
  const box = (await svg.boundingBox())!;
  return { x: box.x + box.width - 30, y: box.y + box.height * 0.45 };
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
}

test('opens on the latest stretch, with history left of it to drag back into', async ({ page, baseURL }) => {
  const svg = await openChart(page, baseURL);
  const visible = await num(svg, 'data-visible-candles');
  const total = await num(svg, 'data-total-candles');
  expect(visible).toBeLessThan(total);
  expect(visible).toBeGreaterThan(100);
});

test('dragging the plot to the right walks back in time, and to the left returns', async ({ page, baseURL }) => {
  const svg = await openChart(page, baseURL);
  const lastBefore = await num(svg, 'data-last-t');

  const p = await plotPoint(svg);
  await drag(page, p, 400, 0);
  const lastAfter = await num(svg, 'data-last-t');
  expect(lastAfter).toBeLessThan(lastBefore);

  await drag(page, p, -400, 0);
  expect(await num(svg, 'data-last-t')).toBe(lastBefore);
});

test('reaching the oldest loaded bar fetches the page of history before it', async ({ page, baseURL }) => {
  const svg = await openChart(page, baseURL);
  const totalBefore = await num(svg, 'data-total-candles');
  const firstLoaded = async () => Number(await svg.getAttribute('data-total-candles'));

  // Zoom right out, so the window reaches back to the oldest loaded bar.
  const p = await plotPoint(svg);
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, 400);

  await expect.poll(firstLoaded, { timeout: 15_000 }).toBeGreaterThan(totalBefore);
});

test('dragging the price axis up stretches the candles, and Auto fits them again', async ({ page, baseURL }) => {
  const svg = await openChart(page, baseURL);
  const span = async () => (await big(svg, 'data-price-max')) - (await big(svg, 'data-price-min'));
  const autoSpan = await span();
  await expect(page.getByTestId('price-auto')).toHaveAttribute('aria-pressed', 'true');

  await drag(page, await priceAxisPoint(svg), 0, -120);
  expect(await span()).toBeLessThan(autoSpan);
  await expect(svg).toHaveAttribute('data-price-auto', 'false');
  await expect(page.getByTestId('price-auto')).toHaveAttribute('aria-pressed', 'false');

  await drag(page, await priceAxisPoint(svg), 0, 240);
  expect(await span()).toBeGreaterThan(autoSpan);

  await page.getByTestId('price-auto').click();
  await expect(svg).toHaveAttribute('data-price-auto', 'true');
  expect(await span()).toBe(autoSpan);
});

test('the wheel zooms price over the price axis and time over the plot', async ({ page, baseURL }) => {
  const svg = await openChart(page, baseURL);
  const span = async () => (await big(svg, 'data-price-max')) - (await big(svg, 'data-price-min'));
  const autoSpan = await span();
  const visible = await num(svg, 'data-visible-candles');

  const axis = await priceAxisPoint(svg);
  await page.mouse.move(axis.x, axis.y);
  await page.mouse.wheel(0, -300);
  expect(await span()).toBeLessThan(autoSpan);
  expect(await num(svg, 'data-visible-candles')).toBe(visible);

  const p = await plotPoint(svg);
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => num(svg, 'data-visible-candles')).toBeLessThan(visible);
});

test('with the price set by hand, dragging the plot moves it up and down too; a double-click on the axis fits it again', async ({
  page,
  baseURL,
}) => {
  const svg = await openChart(page, baseURL);
  await drag(page, await priceAxisPoint(svg), 0, -80);
  const minBefore = await big(svg, 'data-price-min');

  await drag(page, await plotPoint(svg), 0, 120);
  expect(await big(svg, 'data-price-min')).toBeGreaterThan(minBefore);

  const axis = await priceAxisPoint(svg);
  await page.mouse.dblclick(axis.x, axis.y);
  await expect(svg).toHaveAttribute('data-price-auto', 'true');
});

test('with the price on auto, dragging the plot moves only through time', async ({ page, baseURL }) => {
  const svg = await openChart(page, baseURL);
  await drag(page, await plotPoint(svg), 0, 150);
  await expect(svg).toHaveAttribute('data-price-auto', 'true');
});

/** "83,395.28" lost its last digit off the chart's edge; a six-figure BTC price is longer still. */
test('the live price chip on the axis fits a ten-character price', async ({ page, baseURL }) => {
  const svg = await openChart(page, baseURL, 100_000);
  const chipText = page.getByTestId('mark-price-line').locator('text');
  await expect(chipText).toBeVisible();
  const overflow = await chipText.evaluate((el) => {
    const svgEl = (el as SVGTextElement).ownerSVGElement!;
    const box = (el as SVGTextElement).getBBox();
    return box.x + box.width - svgEl.viewBox.baseVal.width;
  });
  expect(overflow).toBeLessThanOrEqual(0);
  void svg;
});
