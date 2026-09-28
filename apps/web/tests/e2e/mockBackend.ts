import type { Page } from '@playwright/test';
import { asciiToBytes32Hex } from '@whitespace/shared/markets';
import { SCALE, toDecimalString } from '@whitespace/shared/decimal';
import { MOCK_PAIR_INDEX, type MockLimitOrder, type MockOrder, type MockPosition, type TestState } from './testState';

// TestState holds raw on-chain base units, as the chain and the indexer do. The real API
// (services/api/src/format.ts) formats every money field into a decimal string on the way
// out, so this mock must do the same — serving raw wei here is how the mock once drifted
// and rendered a 65,001 price as 65,001,000,000,000,000,000,000.
const fmtPrice = (raw: string) => toDecimalString(raw, SCALE.PRICE);
const fmtCollateral = (raw: string) => toDecimalString(raw, SCALE.COLLATERAL);
const fmtLeverage = (raw: string) => toDecimalString(raw, SCALE.LEVERAGE);

function formatPosition(p: MockPosition) {
  return {
    ...p,
    collateral: fmtCollateral(p.collateral),
    leverage: fmtLeverage(p.leverage),
    openPrice: fmtPrice(p.openPrice),
    tp: fmtPrice(p.tp),
    sl: fmtPrice(p.sl),
  };
}

function formatLimitOrder(o: MockLimitOrder) {
  return {
    ...o,
    collateral: fmtCollateral(o.collateral),
    leverage: fmtLeverage(o.leverage),
    triggerPrice: fmtPrice(o.triggerPrice),
    tp: fmtPrice(o.tp),
    sl: fmtPrice(o.sl),
  };
}

function formatOrder(o: MockOrder) {
  return { ...o, collateral: fmtCollateral(o.collateral), leverage: fmtLeverage(o.leverage) };
}

const MOCK_MARKET = {
  pairIndex: MOCK_PAIR_INDEX,
  from: 'BTC',
  to: 'USD',
  feedId: asciiToBytes32Hex('BTC/USD'),
  maxLeverage: fmtLeverage('10000'),
  maxOpenInterest: fmtCollateral('1000000000000'),
  openInterest: { long: fmtCollateral('0'), short: fmtCollateral('0') },
};

function emptyPoints(address: string) {
  return {
    address,
    missions: '0.000000',
    time: '0.000000',
    streak: '0.000000',
    lp: '0.000000',
    total: '0.000000',
    rank: null,
    streakDays: 0,
    streakLongest: 0,
    completedMissions: [] as string[],
    updatedAt: null,
    lpBalance: '0.000000',
    lpSince: null,
  };
}

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
      return route.fulfill({ json: [MOCK_MARKET] });
    }

    if (path === `/markets/${MOCK_PAIR_INDEX}`) {
      return route.fulfill({ json: MOCK_MARKET });
    }

    if (path === `/markets/${MOCK_PAIR_INDEX}/candles`) {
      const now = Math.floor(Date.now() / 1000);
      const candles = Array.from({ length: 5 }, (_, i) => ({
        t: now - (5 - i) * 3600,
        o: fmtPrice('65000000000000000000000'),
        h: fmtPrice('65100000000000000000000'),
        l: fmtPrice('64900000000000000000000'),
        c: fmtPrice(state.markPrice),
        v: fmtCollateral('1000000000'),
      }));
      return route.fulfill({ json: candles });
    }

    if (path === `/price/${MOCK_PAIR_INDEX}`) {
      return route.fulfill({
        json: {
          index: fmtPrice(state.indexPrice),
          mark: fmtPrice(state.markPrice),
          bid: fmtPrice((BigInt(state.markPrice) - state.halfSpread).toString()),
          ask: fmtPrice((BigInt(state.markPrice) + state.halfSpread).toString()),
          source: 'publisher',
          updatedAt: Math.floor(Date.now() / 1000),
          healthyVenues: state.degraded ? 2 : 4,
          minHealthyVenues: 3,
          degraded: state.degraded,
        },
      });
    }

    const positionsMatch = path.match(/^\/positions\/(0x[a-fA-F0-9]+)$/);
    if (positionsMatch) {
      return route.fulfill({ json: state.positions.map(formatPosition) });
    }

    const historyMatch = path.match(/^\/positions\/(0x[a-fA-F0-9]+)\/history$/);
    if (historyMatch) {
      return route.fulfill({ json: [] });
    }

    if (/^\/limit-orders\/0x[a-fA-F0-9]+$/.test(path)) {
      return route.fulfill({ json: state.limitOrders.map(formatLimitOrder) });
    }

    if (/^\/orders\/0x[a-fA-F0-9]+\/history$/.test(path)) {
      return route.fulfill({
        json: [...state.orders].reverse().map((o) => ({
          source: 'order',
          id: o.orderId,
          orderId: o.orderId,
          kind: 'open',
          orderType: 'MARKET',
          pairIndex: o.pairIndex,
          tradeId: o.tradeId ?? null,
          index: null,
          buy: o.buy,
          collateral: fmtCollateral(o.collateral),
          leverage: fmtLeverage(o.leverage),
          price: null,
          tp: null,
          sl: null,
          status: o.status,
          cancelReason: o.cancelReason ?? null,
          requestedAt: o.requestedAt,
          resolvedAt: o.executedAt ?? null,
          txHash: '0x0',
        })),
      });
    }

    if (/^\/fees\/0x[a-fA-F0-9]+$/.test(path)) {
      return route.fulfill({ json: state.fees.map((f) => ({ ...f, amount: fmtCollateral(f.amount) })) });
    }

    if (/^\/pnl\/0x[a-fA-F0-9]+$/.test(path)) {
      const funding = state.fees.filter((f) => f.kind === 'funding' || f.kind === 'rollover');
      const sum = (xs: typeof state.fees) => xs.reduce((a, f) => a + BigInt(f.amount), 0n).toString();
      return route.fulfill({
        json: {
          realizedPnl: fmtCollateral('0'),
          fees: fmtCollateral(sum(state.fees.filter((f) => !funding.includes(f)))),
          funding: fmtCollateral(sum(funding)),
          trades: 0,
        },
      });
    }

    const ordersMatch = path.match(/^\/orders\/(0x[a-fA-F0-9]+)$/);
    if (ordersMatch) {
      return route.fulfill({ json: state.orders.map(formatOrder) });
    }

    if (path === '/points/leaderboard') {
      return route.fulfill({ json: state.leaderboard ?? [] });
    }
    const pointsMatch = path.match(/^\/points\/(0x[a-fA-F0-9]+)$/);
    if (pointsMatch) {
      const addr = (pointsMatch[1] ?? '').toLowerCase();
      return route.fulfill({ json: state.points ? { ...state.points, address: addr } : emptyPoints(addr) });
    }

    return route.fulfill({ status: 404, json: { error: `mock backend: no route for ${path}` } });
  });
}
