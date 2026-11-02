import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { TestState } from './testState';

/**
 * A connected wallet's position drawn over the price chart: the entry tagged with side and
 * leverage, its TP and SL, each with its price in a chip on the axis. The mock's candles
 * span 64,900–65,100, so all three are in view; the mock chain puts the liquidation price at
 * 58,500, far below the candles, where the chart has nowhere to draw it.
 */

const E18 = 10n ** 18n;

test("draws the trader's entry, take-profit and stop-loss over the chart", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = new TestState();
  state.positions.push({
    pairIndex: 0,
    index: 0,
    buy: true,
    collateral: '1000000000',
    leverage: '1000',
    openPrice: state.markPrice,
    tp: String(65_080n * E18),
    sl: String(64_950n * E18),
    openedAt: 1_790_000_000,
    tradeId: '900',
  });
  await installMockWallet(page, state);
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/trade');
  await page.getByTestId('connect-wallet-button').click();

  const levels = page.getByTestId('position-levels');
  await expect(levels.getByTestId('position-level-entry')).toContainText('Long 10.00x');
  await expect(levels.getByTestId('position-level-entry')).toContainText('65,001.00');
  await expect(levels.getByTestId('position-level-tp')).toContainText('65,080.00');
  await expect(levels.getByTestId('position-level-sl')).toContainText('64,950.00');
  await expect(levels.getByTestId('position-level-liq')).toHaveCount(0);
});
