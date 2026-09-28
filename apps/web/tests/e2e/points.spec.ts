import { expect, test } from '@playwright/test';
import { installMockBackend } from './mockBackend';
import { installMockWallet } from './installMockWallet';
import { TestState } from './testState';

/**
 * /points is a connected, API-driven dashboard. These check the real page renders the served
 * totals (not the old "not issued" placeholder) and that an empty wallet reads as a genuine
 * zero rather than an error. lpSince is null so the live LP counter has no anchor to run from,
 * keeping the rendered figures deterministic; the accrual maths is unit-tested separately.
 */

test('shows the served season totals and the four component cards', async ({ page, baseURL }) => {
  const state = new TestState();
  state.points = {
    missions: '500.000000',
    time: '214.600000',
    streak: '128.000000',
    lp: '96.400000',
    total: '939.000000',
    rank: 7,
    streakDays: 5,
    streakLongest: 9,
    completedMissions: ['first_market_trade', 'limit_filled'],
    updatedAt: 1788881880,
    lpBalance: '8500.000000',
    lpSince: null,
  };
  await installMockWallet(page, state);
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/points');
  await page.getByTestId('connect-wallet-button').click();

  await expect(page.getByTestId('points-total')).toContainText('939');
  await expect(page.getByTestId('points-rank')).toContainText('#7');
  await expect(page.getByTestId('points-multiplier')).toContainText('×1.33');
  await expect(page.getByTestId('missions-progress')).toHaveText('2/12');
  await expect(page.getByTestId('streak-days')).toContainText('5');
  await expect(page.getByTestId('time-live')).toContainText('214.6');
  await expect(page.getByTestId('card-lp')).toContainText('8,500');
});

test('a wallet with no points reads as a genuine zero, not an error', async ({ page, baseURL }) => {
  const state = new TestState(); // no state.points -> the mock serves an empty summary
  await installMockWallet(page, state);
  await installMockBackend(page, state, `${baseURL}/__api`);

  await page.goto('/points');
  await page.getByTestId('connect-wallet-button').click();

  await expect(page.getByTestId('points-total')).toContainText('0.00');
  await expect(page.getByTestId('missions-progress')).toHaveText('0/12');
  await expect(page.getByTestId('points-rank')).toContainText('—');
});
