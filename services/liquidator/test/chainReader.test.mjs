import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainReader, quoteFromStatus, isTriggerPending } from '../src/chainReader.mjs';
import { MARKETS as MARKET_MAP } from '@whitespace/shared/markets';

const MARKETS = Object.values(MARKET_MAP);

const TRADER = '0x1111111111111111111111111111111111111111';
const ADDR = {
  tradingStorageAddress: '0x0000000000000000000000000000000000000001',
  pairInfosAddress: '0x0000000000000000000000000000000000000002',
  pairsStorageAddress: '0x0000000000000000000000000000000000000003',
  tradingAddress: '0x0000000000000000000000000000000000000004',
};

/**
 * A viem-shaped client: values come back typed the way viem decodes them — uint8..uint48
 * as `number`, wider ints as `bigint`.
 */
function fakeClient(responses, { head = 1000n } = {}) {
  const calls = [];
  return {
    calls,
    getBlockNumber: async () => head,
    readContract: async ({ address, functionName, args }) => {
      calls.push({ address, functionName, args });
      const r = responses[functionName];
      if (r === undefined) throw new Error(`unexpected call ${functionName}`);
      return typeof r === 'function' ? r(args) : r;
    },
  };
}

const OPEN_TRADE = {
  collateral: 1_000_000000n,
  openPrice: 100n * 10n ** 18n,
  tp: 110n * 10n ** 18n,
  sl: 95n * 10n ** 18n,
  trader: TRADER,
  leverage: 1000, // uint32 -> number
  pairIndex: 0,
  index: 2,
  buy: true,
  isDayTrade: true,
};
const TRADE_INFO = { tradeId: 42n, oiNotional: 1n, initialLeverage: 1000, tpLastUpdated: 11, slLastUpdated: 12, createdAt: 10, deprecatedBeingMarketClosed: false };

test('readTrade returns null for an empty slot, where viem decodes the uint32 leverage as the number 0', async () => {
  const client = fakeClient({ getOpenTrade: { ...OPEN_TRADE, leverage: 0 } });
  const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://x' });
  assert.equal(await reader.readTrade(TRADER, 0, 2), null);
  assert.deepEqual(client.calls.map((c) => c.functionName), ['getOpenTrade'], 'no fee reads for an empty slot');
});

test('readTrade normalises every numeric field to bigint and carries tp/sl/isDayTrade/timestamps', async () => {
  const client = fakeClient({
    getOpenTrade: OPEN_TRADE,
    getOpenTradeInfo: TRADE_INFO,
    getTradeRolloverFee: 5n,
    getTradeFundingFee: [-7n, 0n],
  });
  const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://x' });
  const t = await reader.readTrade(TRADER, 0, 2);
  assert.deepEqual(t, {
    tradeId: 42n,
    collateral: 1_000_000000n,
    leverage: 1000n,
    openPrice: 100n * 10n ** 18n,
    tp: 110n * 10n ** 18n,
    sl: 95n * 10n ** 18n,
    buy: true,
    isDayTrade: true,
    initialLeverage: 1000n,
    createdAt: 10,
    tpLastUpdated: 11,
    slLastUpdated: 12,
    rolloverFee: 5n,
    fundingFee: -7n,
  });
  const fee = client.calls.find((c) => c.functionName === 'getTradeFundingFee');
  assert.deepEqual(fee.args, [TRADER, 0, 2, true, 1_000_000000n, 1000]);
});

const LIMIT_ORDER = {
  collateral: 5_000000n,
  targetPrice: 99n * 10n ** 18n,
  tp: 0n,
  sl: 0n,
  trader: TRADER,
  leverage: 250,
  createdAt: 100,
  lastUpdated: 105,
  pairIndex: 1,
  orderType: 1,
  index: 0,
  buy: false,
  isDayTrade: false,
};

test('readLimitOrder: null without an open order (never calls the reverting getter)', async () => {
  const client = fakeClient({ hasOpenLimitOrder: false });
  const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://x' });
  assert.equal(await reader.readLimitOrder(TRADER, 1, 0), null);
  assert.deepEqual(client.calls.map((c) => c.functionName), ['hasOpenLimitOrder']);
});

test('readLimitOrder maps OpenOrderType 1 -> LIMIT and 2 -> STOP, and rejects MARKET', async () => {
  for (const [code, name] of [
    [1, 'LIMIT'],
    [2, 'STOP'],
  ]) {
    const client = fakeClient({ hasOpenLimitOrder: true, getOpenLimitOrder: { ...LIMIT_ORDER, orderType: code } });
    const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://x' });
    assert.deepEqual(await reader.readLimitOrder(TRADER, 1, 0), {
      orderType: name,
      buy: false,
      isDayTrade: false,
      targetPrice: 99n * 10n ** 18n,
      tp: 0n,
      sl: 0n,
      collateral: 5_000000n,
      leverage: 250n,
      lastUpdated: 105,
    });
  }
  const client = fakeClient({ hasOpenLimitOrder: true, getOpenLimitOrder: { ...LIMIT_ORDER, orderType: 0 } });
  const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://x' });
  await assert.rejects(reader.readLimitOrder(TRADER, 1, 0), /unexpected orderType/);
});

test('readOpenFees takes takerFeeP (2nd field), the oracle fee and the builder data', async () => {
  const client = fakeClient({
    pairOpeningFees: [1, 50_000, 3, 4, 5, 6],
    pairOracleFee: 1_000000n,
    getBuilderData: { builder: '0x' + '22'.repeat(20), builderFee: 100 },
  });
  const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://x' });
  assert.deepEqual(await reader.readOpenFees(TRADER, 1, 3), {
    takerFeeP: 50_000n,
    oracleFee: 1_000000n,
    builder: '0x' + '22'.repeat(20),
    builderFee: 100n,
  });
  assert.deepEqual(client.calls.find((c) => c.functionName === 'getBuilderData').args, [TRADER, 1, 3n]);
});

test('readImpact reads params and state into bigints', async () => {
  const client = fakeClient({ pairDynamicSpreadParams: [1n, 2n, 3n], pairDynamicSpreadState: [4n, 5n, 6] });
  const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://x' });
  assert.deepEqual(await reader.readImpact(0), {
    netVolThreshold: 1n,
    decayRate: 2n,
    priceImpactK: 3n,
    buyVolume: 4n,
    sellVolume: 5n,
    lastUpdateTimestamp: 6n,
  });
});

test('readMaxLeverage follows getEffectiveMaxLeverage for day and overnight trades', async () => {
  const withOvernight = createChainReader({ publicClient: fakeClient({ pairMaxLeverage: 10000, pairOvernightMaxLeverage: 5000 }), ...ADDR, publisherBaseUrl: 'http://x' });
  assert.equal(await withOvernight.readMaxLeverage(0, true), 10000n);
  assert.equal(await withOvernight.readMaxLeverage(0, false), 5000n);
  const noOvernight = createChainReader({ publicClient: fakeClient({ pairMaxLeverage: 10000, pairOvernightMaxLeverage: 0 }), ...ADDR, publisherBaseUrl: 'http://x' });
  assert.equal(await noOvernight.readMaxLeverage(0, false), 10000n);
});

test('readLiqMarginThresholdP returns a bigint from the uint8', async () => {
  const reader = createChainReader({ publicClient: fakeClient({ liqMarginThresholdP: 25 }), ...ADDR, publisherBaseUrl: 'http://x' });
  assert.equal(await reader.readLiqMarginThresholdP(), 25n);
});

test('isTriggerPending mirrors checkNoPendingTrigger for the block our tx lands in (head + 1)', () => {
  assert.equal(isTriggerPending(0n, 1000n, 30n), false, 'never triggered');
  assert.equal(isTriggerPending(1000n, 1000n, 30n), true);
  assert.equal(isTriggerPending(971n, 999n, 30n), true, 'lands at 1000: 1000 - 971 = 29 < 30');
  assert.equal(isTriggerPending(971n, 1000n, 30n), false, 'lands at 1001: 30 >= 30');
});

test('readTriggerPending reads the trigger block for the given kind, the head and triggerTimeout', async () => {
  const client = fakeClient({ orderTriggerBlock: 990n, triggerTimeout: 30 }, { head: 1000n });
  const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://x' });
  assert.equal(await reader.readTriggerPending(TRADER, 0, 2, 1), true);
  const trig = client.calls.find((c) => c.functionName === 'orderTriggerBlock');
  assert.deepEqual(trig.args, [TRADER, 0, 2, 1]);
  assert.equal(client.calls.find((c) => c.functionName === 'triggerTimeout').address, ADDR.tradingAddress);
});

test('quoteFromStatus: price = mark, bid/ask = index quote with the mark as fallback per side', () => {
  assert.equal(quoteFromStatus(undefined), null);
  assert.equal(quoteFromStatus({ mark: null }), null);
  assert.deepEqual(quoteFromStatus({ mark: '100', indexBid: '99', indexAsk: '101', healthyCount: 4, minHealthyVenues: 3 }), {
    price: 100n,
    bid: 99n,
    ask: 101n,
    healthyVenueCount: 4,
    minHealthyVenues: 3,
  });
  const partial = quoteFromStatus({ mark: '100', indexBid: null, healthyCount: 1 });
  assert.equal(partial.bid, 100n);
  assert.equal(partial.ask, 100n);
  assert.equal(partial.minHealthyVenues, 3, 'falls back to the global minimum when the publisher omits it');
});

test('readPriceSnapshot fetches /status once and resolves any pair against it', async () => {
  const market = MARKETS[0];
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches++;
    assert.equal(String(url), 'http://publisher:8787/status');
    return { ok: true, json: async () => ({ feeds: { [market.feed]: { mark: '5', indexBid: '4', indexAsk: '6', healthyCount: 3, minHealthyVenues: 3 } } }) };
  };
  const client = fakeClient({ pairFeed: () => market.feedId });
  const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://publisher:8787', fetchImpl });
  const snap = await reader.readPriceSnapshot();
  assert.equal((await snap.quoteFor(0)).price, 5n);
  assert.equal((await snap.quoteFor(0)).ask, 6n);
  assert.equal(fetches, 1);
  assert.equal(client.calls.filter((c) => c.functionName === 'pairFeed').length, 1, 'feed id cached');
});

test('readPriceSnapshot: a non-200 publisher and a feed without a mark both throw', async () => {
  const client = fakeClient({ pairFeed: () => MARKETS[0].feedId });
  const down = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://p', fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(down.readPriceSnapshot(), /503/);
  const noMark = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://p', fetchImpl: async () => ({ ok: true, json: async () => ({ feeds: {} }) }) });
  const snap = await noMark.readPriceSnapshot();
  await assert.rejects(snap.quoteFor(0), /no mark price/);
});

test('an unknown feed id is an error, not a silent skip', async () => {
  const client = fakeClient({ pairFeed: () => '0x' + 'ab'.repeat(32) });
  const reader = createChainReader({ publicClient: client, ...ADDR, publisherBaseUrl: 'http://p', fetchImpl: async () => ({ ok: true, json: async () => ({ feeds: {} }) }) });
  const snap = await reader.readPriceSnapshot();
  await assert.rejects(snap.quoteFor(0), /not in @whitespace\/shared\/markets/);
});
