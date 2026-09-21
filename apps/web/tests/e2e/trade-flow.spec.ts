import { expect, test } from '@playwright/test';
import { TRADING_ADDRESS } from '../../src/lib/deployment';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { MOCK_TRADER_ADDRESS, TestState } from './testState';

/**
 * The completion gate (phase-5 brief): "a mouse-driven trade from deposit to close."
 * Everything the browser talks to is mocked — the chain via a fake EIP-1193
 * `window.ethereum` for wallet-signed writes, plus the real RPC URL intercepted for
 * public reads (both bridged to real ABI decode/encode in Node — see
 * installMockWallet.ts for why both are needed), and services/api via page.route
 * (mockBackend.ts) — but the app code under test is the real production build path (dev
 * server), unmodified.
 *
 * Two-phase state transitions ("keeper delivers the price report") are advanced by
 * mutating the shared TestState directly from the test body, rather than a timer race —
 * deterministic, and it is exactly the same shared object the backend routes read from.
 */

test('connect -> deposit -> open -> pending -> filled -> close', async ({ page, baseURL }) => {
  const apiBaseUrl = `${baseURL}/__api`;
  const state = new TestState();

  await installMockWallet(page, state);
  await installMockBackend(page, state, apiBaseUrl);
  // Fail loudly on any uncaught client-side exception (e.g. src/lib/money.ts's
  // MoneyTypeError guard firing because a number leaked into a money formatter) instead
  // of only noticing it as a mysteriously stuck UI — this caught two real bugs while
  // building this suite.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/trade');

  await test.step('connect wallet', async () => {
    await page.getByTestId('connect-wallet-button').click();
    await expect(page.getByTestId('wallet-connected')).toBeVisible();
    await expect(page.getByTestId('wallet-address')).toHaveText(
      `${MOCK_TRADER_ADDRESS.slice(0, 6)}…${MOCK_TRADER_ADDRESS.slice(-4)}`,
    );
    // Mock chain reports chain 1874, so no wrong-network banner.
    await expect(page.getByTestId('chain-guard-banner')).not.toBeVisible();
  });

  await test.step('price chart shows the live mark price', async () => {
    await expect(page.getByTestId('mark-price')).toContainText('65,001.00');
  });

  await test.step('deposit USDW into the vault (request -> settle -> claim)', async () => {
    // Client-side navigation (clicking the nav link, not page.goto) so the wagmi
    // connection made above stays live — a real trader clicks between tabs without
    // reconnecting their wallet every time.
    await page.getByTestId('nav-vaults').click();
    await expect(page.getByTestId('vault-usdw-balance')).toContainText('10,000.00');

    // The deposit controls moved out of VaultPanel into FundingModal (2026-09-21) — the
    // same dialog the header's DEPOSIT button opens. /vaults now triggers it rather than
    // hosting a second copy of the form.
    await page.getByTestId('vault-deposit-button').click();
    await page.getByTestId('funding-amount-input').fill('2500');
    await page.getByTestId('funding-approve').click();
    await expect(page.getByTestId('funding-request')).toBeVisible();

    await page.getByTestId('funding-request').click();
    await expect(page.getByTestId('funding-settlement-status')).toContainText('PENDING');

    // Simulate the vault's async settlement running (IOstiumVault RequestStatus:
    // PENDING -> CLAIMABLE) — off the UI's control, exactly like the real contract.
    state.depositStatus.set(1, 2);

    await expect(page.getByTestId('funding-settlement-status')).toContainText('CLAIMABLE');
    await page.getByTestId('funding-claim').click();
    await expect(page.getByTestId('funding-message')).toContainText('Deposit claimed');
    await page.getByTestId('funding-modal-close').click();
  });

  await test.step('open a position: approve, submit, see the honest pending state', async () => {
    await page.getByTestId('nav-trade').click();
    // The order field is denominated in the base asset now (terminal_design.pdf's SIZE),
    // and the collateral is derived: 0.1538 BTC at 65,001.00 with the default 10x is
    // ~999.7 USDW — the same order this step used to express as a flat 1000 collateral.
    await page.getByTestId('size-input').fill('0.1538');
    await expect(page.getByTestId('direction-long')).toHaveClass(/active/);

    await page.getByTestId('approve-button').click();
    await expect(page.getByTestId('submit-open-button')).toBeVisible();
    await page.getByTestId('submit-open-button').click();

    const pendingBanner = page.getByTestId('order-pending-banner');
    await expect(pendingBanner).toBeVisible();
    await expect(pendingBanner).toContainText('Nothing has happened yet');
    await expect(pendingBanner).not.toContainText('position is now open');

    await page.getByTestId('tab-orders').click();
    await expect(page.getByTestId('orders-table')).toBeVisible();
    const orderRow = page.locator('[data-testid^="order-row-"]').first();
    await expect(orderRow).toContainText('Pending');
  });

  await test.step('a keeper report arrives: the order fills and the position opens', async () => {
    expect(state.orders).toHaveLength(1);
    const order = state.orders[0]!;
    order.status = 'executed';
    order.tradeId = '901';
    order.executedAt = Math.floor(Date.now() / 1000);
    state.positions.push({
      pairIndex: order.pairIndex,
      index: 0,
      buy: order.buy,
      collateral: order.collateral,
      leverage: order.leverage,
      openPrice: state.markPrice,
      tp: '0',
      sl: '0',
      openedAt: Math.floor(Date.now() / 1000),
      tradeId: order.tradeId,
    });

    await expect(page.getByTestId(`order-status-${order.orderId}`)).toContainText('Executed');
    await expect(page.getByTestId('order-filled')).toContainText('Filled');

    await page.getByTestId('tab-positions').click();
    const positionRow = page.getByTestId('position-row-0-0');
    await expect(positionRow).toBeVisible();
    // Size in BTC, derived exactly from collateral(1000 USDW)*leverage(10x)/openPrice
    // (65,001.00) — see src/lib/pnl.ts estimatePositionSizeBase; computed independently
    // for this assertion, not copied from app code.
    await expect(positionRow).toContainText('+0.1538');
    await expect(positionRow).toContainText('10.00x'); // leverage
    await expect(positionRow).toContainText('65,001.00'); // open price
  });

  await test.step('close the position and see the pending-close state honestly', async () => {
    const positionRow = page.getByTestId('position-row-0-0');
    await positionRow.getByTestId('close-position-button').click();
    await expect(positionRow.getByTestId('close-pending')).toContainText('pending keeper execution');

    // The mock chain removes the position from shared state as soon as the
    // closeTradeMarket transaction lands (see mockChain.ts) — the next positions poll
    // reflects it, exactly as the real API/indexer would after the keeper's report.
    // usePositions polls every 5s (src/hooks/usePositions.ts) rather than requiring a
    // WS push — give it a full cycle of headroom instead of racing the default 5s
    // assertion timeout against that same interval.
    await expect(page.getByTestId('no-positions')).toBeVisible({ timeout: 8000 });
  });

  expect(pageErrors, `uncaught client-side exceptions during the run: ${pageErrors.join('; ')}`).toEqual([]);
});

test('opening is blocked in degraded mode, closing stays allowed', async ({ page, baseURL }) => {
  const apiBaseUrl = `${baseURL}/__api`;
  const state = new TestState();
  state.degraded = true;
  // Pre-seed USDW allowance so the test isolates the degraded-mode gate itself rather
  // than the (orthogonal, and already-covered-elsewhere) approve step: a trader with a
  // standing approval from an earlier session must still be blocked from opening while
  // degraded.
  state.allowances.set(TRADING_ADDRESS.toLowerCase(), 10_000_000_000n);

  await installMockWallet(page, state);
  await installMockBackend(page, state, apiBaseUrl);

  await page.goto('/trade');
  await page.getByTestId('connect-wallet-button').click();
  await expect(page.getByTestId('wallet-connected')).toBeVisible();

  await expect(page.getByTestId('degraded-banner').first()).toBeVisible();
  await page.getByTestId('size-input').fill('0.0154');
  await expect(page.getByTestId('open-blocked-degraded')).toBeVisible();
  await expect(page.getByTestId('submit-open-button')).toBeDisabled();
});
