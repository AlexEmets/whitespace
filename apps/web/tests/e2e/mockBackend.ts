import type { Page } from '@playwright/test';
import { asciiToBytes32Hex } from '@whitespace/shared/markets';
import { MOCK_PAIR_INDEX, type TestState } from './testState';

/**
 * Registers page.route handlers standing in for services/api (D3's REST surface) against
 * the shared TestState. This is the "read via API" half of the architecture — the mock
 * chain (mockChain.ts) is the "write via wallet-signed tx" half. Every monetary field is
 * emitted as a decimal string, matching D3 ("never a JSON number").
 */
export async function installMockBackend(page: Page, state: TestState, apiBaseUrl: string) {
  const apiPathPrefix = new URL(apiBaseUrl).pathname;

  await page.route(`${apiBaseUrl}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.startsWith(apiPathPrefix) ? url.pathname.slice(apiPathPrefix.length) : url.pathname;

    if (path === '/health') {
      return route.fulfill({ json: { status: 'ok', chainId: 1874, indexedBlock: 1, lagSeconds: 0 } });
    }

    if (path === '/markets') {
      return route.fulfill({
        json: [
          {
            pairIndex: MOCK_PAIR_INDEX,
            from: 'BTC',
            to: 'USD',
            feedId: asciiToBytes32Hex('BTC/USD'),
            maxLeverage: '10000',
            maxOpenInterest: '1000000000000',
            openInterest: { long: '0', short: '0' },
          },
        ],
      });
    }

    if (path === `/markets/${MOCK_PAIR_INDEX}`) {
      return route.fulfill({
        json: {
          pairIndex: MOCK_PAIR_INDEX,
          from: 'BTC',
          to: 'USD',
          feedId: asciiToBytes32Hex('BTC/USD'),
          maxLeverage: '10000',
          maxOpenInterest: '1000000000000',
          openInterest: { long: '0', short: '0' },
        },
      });
    }

    if (path === `/markets/${MOCK_PAIR_INDEX}/candles`) {
      const now = Math.floor(Date.now() / 1000);
      const candles = Array.from({ length: 5 }, (_, i) => ({
        t: now - (5 - i) * 3600,
        o: '65000000000000000000000',
        h: '65100000000000000000000',
        l: '64900000000000000000000',
        c: state.markPrice,
        v: '1000000000',
      }));
      return route.fulfill({ json: candles });
    }

    if (path === `/price/${MOCK_PAIR_INDEX}`) {
      return route.fulfill({
        json: {
          index: state.indexPrice,
          mark: state.markPrice,
          updatedAt: Math.floor(Date.now() / 1000),
          healthyVenues: state.degraded ? 2 : 4,
          minHealthyVenues: 3,
          degraded: state.degraded,
        },
      });
    }

    const positionsMatch = path.match(/^\/positions\/(0x[a-fA-F0-9]+)$/);
    if (positionsMatch) {
      return route.fulfill({ json: state.positions });
    }

    const historyMatch = path.match(/^\/positions\/(0x[a-fA-F0-9]+)\/history$/);
    if (historyMatch) {
      return route.fulfill({ json: [] });
    }

    const ordersMatch = path.match(/^\/orders\/(0x[a-fA-F0-9]+)$/);
    if (ordersMatch) {
      return route.fulfill({ json: state.orders });
    }

    return route.fulfill({ status: 404, json: { error: `mock backend: no route for ${path}` } });
  });
}
