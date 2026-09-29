import { expect, test, type Page } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { MOCK_TRADER_ADDRESS, TestState } from './testState';

/**
 * The Variational-style terminal end to end against the mock chain and API: the vault quote on
 * the side buttons, market orders with TP/SL, resting limit orders placed, listed and cancelled,
 * position management, and the history tabs. Every assertion on what was signed reads the
 * decoded call the mock chain recorded — the contract call itself, not the UI's own summary.
 */

const E18 = 10n ** 18n;

async function setUp(page: Page, baseURL: string | undefined, configure?: (s: TestState) => void) {
  const state = new TestState();
  state.halfSpread = 65n * E18 / 10n; // bid/ask ±6.50 around 65,001
  configure?.(state);
  await installMockWallet(page, state);
  await installMockBackend(page, state, `${baseURL}/__api`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/trade');
  await page.getByTestId('connect-wallet-button').click();
  await expect(page.getByTestId('wallet-connected')).toBeVisible();
  return { state, errors };
}

function lastCall(state: TestState, name: string) {
  const call = [...state.sentTrading].reverse().find((c) => c.functionName === name);
  if (!call) throw new Error(`no ${name} was signed`);
  return call;
}

test('the side buttons carry the vault quote, and the spread is shown', async ({ page, baseURL }) => {
  const { errors } = await setUp(page, baseURL);
  await expect(page.getByTestId('quote-buy')).toHaveText('65,007.50');
  await expect(page.getByTestId('quote-sell')).toHaveText('64,994.50');
  await expect(page.getByTestId('quote-spread')).toHaveText('0.0200%');
  expect(errors).toEqual([]);
});

test('a market long with TP/SL signs openTrade at the quoted ask with both levels', async ({ page, baseURL }) => {
  const { state, errors } = await setUp(page, baseURL);
  await page.getByTestId('size-input').fill('0.01');
  await page.getByTestId('tpsl-toggle').check();
  await page.getByTestId('tp-input').fill('70000');
  await page.getByTestId('sl-input').fill('60000');
  await page.getByTestId('submit-open-button').click();
  await expect(page.getByTestId('order-pending-banner')).toBeVisible();

  const [trade, , orderType, slippage] = lastCall(state, 'openTrade').args as [
    { openPrice: bigint; tp: bigint; sl: bigint; buy: boolean },
    unknown,
    number,
    bigint,
  ];
  expect(orderType).toBe(0);
  expect(trade.buy).toBe(true);
  expect(trade.openPrice).toBe(65_007_500_000_000_000_000_000n);
  expect(trade.tp).toBe(70_000n * E18);
  expect(trade.sl).toBe(60_000n * E18);
  expect(slippage).toBe(50n);
  expect(errors).toEqual([]);
});

test('a limit buy rests in Open Orders and can be cancelled', async ({ page, baseURL }) => {
  const { state, errors } = await setUp(page, baseURL);
  await page.getByTestId('order-kind-limit').click();
  await page.getByTestId('trigger-price-input').fill('60000');
  await page.getByTestId('size-input').fill('0.01');
  await page.getByTestId('submit-open-button').click();
  await expect(page.getByTestId('order-placed')).toContainText('rests on chain');

  const [trade, , orderType, slippage] = lastCall(state, 'openTrade').args as [
    { openPrice: bigint },
    unknown,
    number,
    bigint,
  ];
  expect(orderType).toBe(1);
  expect(trade.openPrice).toBe(60_000n * E18);
  expect(slippage).toBe(0n); // the contract requires exactly 0 for resting orders

  await page.getByTestId('tab-orders').click();
  const row = page.getByTestId('limit-order-row-0-0');
  await expect(row).toContainText('Limit buy');
  await expect(row).toContainText('60,000.00');

  await page.getByTestId('limit-cancel-0-0').click();
  await expect.poll(() => state.sentTrading.some((c) => c.functionName === 'cancelOpenLimitOrder')).toBe(true);
  await expect(page.getByTestId('no-limit-orders')).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

test('a limit order can be re-priced from the Open Orders tab', async ({ page, baseURL }) => {
  const { state } = await setUp(page, baseURL, (s) => {
    s.limitOrders.push({
      pairIndex: 0, index: 0, orderType: 'LIMIT', buy: true, collateral: '100000000', leverage: '1000',
      triggerPrice: (60_000n * E18).toString(), tp: '0', sl: '0', placedAt: 1_790_000_000, updatedAt: 1_790_000_000,
    });
  });
  await page.getByTestId('tab-orders').click();
  await page.getByTestId('limit-edit-0-0').click();
  await page.getByTestId('limit-trigger-input-0-0').fill('59500');
  await page.getByTestId('limit-save-0-0').click();
  await expect.poll(() => state.sentTrading.some((c) => c.functionName === 'updateOpenLimitOrder')).toBe(true);
  expect(lastCall(state, 'updateOpenLimitOrder').args.slice(0, 3)).toEqual([0, 0, 59_500n * E18]);
});

test('a take profit is moved from the positions table', async ({ page, baseURL }) => {
  const { state, errors } = await setUp(page, baseURL, (s) => {
    s.positions.push({
      pairIndex: 0, index: 0, buy: true, collateral: '1000000000', leverage: '1000',
      openPrice: s.markPrice, tp: '0', sl: '0', openedAt: 1_790_000_000, tradeId: '900',
    });
  });
  await page.getByTestId('tab-positions').click();
  await page.getByTestId('manage-toggle').click();
  await page.getByTestId('manage-tp-input').fill('70000');
  await page.getByTestId('manage-tp-save').click();
  await expect(page.getByTestId('manage-message')).toHaveText('Take profit updated.');
  expect(lastCall(state, 'updateTp').args).toEqual([0, 0, 70_000n * E18]);
  expect(errors).toEqual([]);
});

test('history tabs show funding, orders and realised totals', async ({ page, baseURL }) => {
  await setUp(page, baseURL, (s) => {
    s.fees.push(
      { id: 'f1', tradeId: '900', pairIndex: 0, kind: 'funding', amount: '1500000', at: 1_790_000_000, txHash: '0x1' },
      { id: 'f2', tradeId: '900', pairIndex: 0, kind: 'dev', amount: '3000000', at: 1_790_000_000, txHash: '0x1' },
    );
  });
  await page.getByTestId('tab-funding').click();
  await expect(page.getByTestId('funding-row-f1')).toContainText('-1.50 USDW');
  await expect(page.getByTestId('funding-row-f2')).toHaveCount(0);

  await page.getByTestId('tab-pnl').click();
  await expect(page.getByTestId('realized-pnl')).toContainText('3.00 USDW');

  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('no-order-history')).toBeVisible();
});

test('the markets rail carries no oracle card, only the account', async ({ page, baseURL }) => {
  await setUp(page, baseURL);
  await expect(page.getByTestId('account-summary')).toBeVisible();
  await expect(page.getByTestId('oracle-status')).toHaveCount(0);
});

test('the funding rate is read from chain into the header', async ({ page, baseURL }) => {
  await setUp(page, baseURL, (s) => {
    s.fundingRatePerBlock = 31_709_791_983n;
  });
  await expect(page.getByTestId('funding-rate')).toHaveText('+0.0114%');
});

test('an open position can be shared: the dialog previews its card and posts the link to X', async ({ page, baseURL }) => {
  const { errors } = await setUp(page, baseURL, (s) => {
    s.positions.push({
      pairIndex: 0, index: 0, buy: true, collateral: '1000000000', leverage: '1000',
      openPrice: s.markPrice, tp: '0', sl: '0', openedAt: 1_790_000_000, tradeId: '900',
    });
  });
  const address = MOCK_TRADER_ADDRESS.toLowerCase();
  await page.getByTestId('tab-positions').click();
  await page.getByTestId('position-share-0-0').click();

  await expect(page.getByTestId('share-dialog')).toBeVisible();
  await expect(page.getByTestId('share-preview')).toHaveAttribute('src', `/share/${address}/o900/card.png`);
  const href = await page.getByTestId('share-x').getAttribute('href');
  const intent = new URL(href!);
  expect(intent.origin + intent.pathname).toBe('https://x.com/intent/tweet');
  expect(intent.searchParams.get('url')).toBe(`${baseURL}/share/${address}/o900`);
  expect(intent.searchParams.get('text')).toMatch(/^Riding a 10× long on BTC-PERP, [+-]\d+\.\d{2}% so far, on Whitespace testnet$/);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('share-dialog')).toBeHidden();
  expect(errors).toEqual([]);
});
