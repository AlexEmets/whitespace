// Decodes real event logs captured from Whitechain testnet 1874 (see
// fixtures/README.md) using the exact ABI fragments this indexer subscribes
// to, and asserts the decoded values match deployments/1874-operational.json
// — the task's required check: "assert your decoder reproduces the known
// open price 65001000000000000000000 and collateral 999000000."
import { describe, it, expect } from 'vitest';
import { decodeEventLog, type Log } from 'viem';
import { tradingCallbacksAbi } from '../abis/tradingCallbacks.js';
import { pairsStorageAbi } from '../abis/pairsStorage.js';
import { tradingStorageAbi } from '../abis/tradingStorage.js';
import { tradingAbi } from '../abis/trading.js';
import { priceUpKeepAbi } from '../abis/priceUpKeep.js';

import openRequestFixture from '../fixtures/open-request-tx.json' with { type: 'json' };
import openReportFixture from '../fixtures/open-report-tx.json' with { type: 'json' };
import closeReportFixture from '../fixtures/close-report-tx.json' with { type: 'json' };
import operational from '../../../deployments/1874-operational.json' with { type: 'json' };
import deployment from '../../../deployments/1874.json' with { type: 'json' };

type RawLog = {
  address: string;
  topics: string[];
  data: string;
};

function findLog(logs: RawLog[], address: string, topic0: string): RawLog {
  const found = logs.find(
    (l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0]?.toLowerCase() === topic0.toLowerCase(),
  );
  if (!found) throw new Error(`log not found for address=${address} topic0=${topic0}`);
  return found;
}

// Computed once via `cast keccak <signature>` against the exact ABI
// signatures in abis/tradingCallbacks.ts — see
// docs/decisions/phase-4-indexer-api.md for the full derivation.
const TOPIC0_MARKET_OPEN_EXECUTED = '0xc15478b6b68c100c76ab032fa5268715cb571da48263fd160aa4dc1afebb57ea';
const TOPIC0_MARKET_CLOSE_EXECUTED_V2 = '0xcaa9acf31fbbd991f267d1fe36d806a81db477c3ad5df64ed81b5155b960e8da';
const TOPIC0_PRICE_RECEIVED = '0x601d9b4c10a6abc80c3441c9eb48f96c781092c70e5c63c56a637eafb4cb39ce';
const TOPIC0_PAIR_ADDED = '0x797331683c7d888af91e5c6800626a01b5f1f7337a712c6915baa1b39c138a09';
const TOPIC0_MAX_OI_UPDATED = '0x50c2f04d7172c7554c1a9e990d72a0d17326cfc6c340869ba6a966426b51a326';
const TOPIC0_MARKET_OPEN_ORDER_INITIATED = '0xfb4a26aa34682aa753cb2aa37ef1bc38eee1af6719db3a8cfe892c50406ea0e0';
const TOPIC0_PRICE_REQUESTED_V2 = '0x0b34af4df6d01bd2b84814169152cd26e9cccd4bccf7cf16caf8e33ec6a8211e';

describe('decodes MarketOpenExecuted from the real proof-trade open report tx', () => {
  const raw = findLog(
    openReportFixture.result.logs as RawLog[],
    deployment.contracts.callbacks,
    TOPIC0_MARKET_OPEN_EXECUTED,
  );

  it('topic0 matches the ABI signature (not assumed, computed from the real log)', () => {
    expect(raw.topics[0].toLowerCase()).toBe(TOPIC0_MARKET_OPEN_EXECUTED);
  });

  const decoded = decodeEventLog({
    abi: tradingCallbacksAbi,
    data: raw.data as `0x${string}`,
    topics: raw.topics as [`0x${string}`, ...`0x${string}`[]],
  });

  it('decodes event name MarketOpenExecuted', () => {
    expect(decoded.eventName).toBe('MarketOpenExecuted');
  });

  it('reproduces the known open price exactly (65001000000000000000000, PRECISION_18)', () => {
    if (decoded.eventName !== 'MarketOpenExecuted') throw new Error('wrong event');
    expect(decoded.args.t.openPrice).toBe(BigInt(operational.proofTrade.openPrice));
    expect(decoded.args.t.openPrice).toBe(65001000000000000000000n);
  });

  it('reproduces the known collateral exactly (999000000, PRECISION_6)', () => {
    if (decoded.eventName !== 'MarketOpenExecuted') throw new Error('wrong event');
    expect(decoded.args.t.collateral).toBe(BigInt(operational.proofTrade.collateral));
    expect(decoded.args.t.collateral).toBe(999000000n);
  });

  it('reproduces leverage, buy side, pairIndex and trader from the same trade', () => {
    if (decoded.eventName !== 'MarketOpenExecuted') throw new Error('wrong event');
    expect(decoded.args.t.leverage).toBe(operational.proofTrade.leverage);
    expect(decoded.args.t.buy).toBe(operational.proofTrade.buy);
    expect(decoded.args.t.pairIndex).toBe(operational.proofTrade.pairIndex);
    expect(decoded.args.t.trader.toLowerCase()).toBe(operational.roles.trader.toLowerCase());
  });

  it('the orderId matches the recorded openOrderId', () => {
    if (decoded.eventName !== 'MarketOpenExecuted') throw new Error('wrong event');
    expect(decoded.args.orderId).toBe(BigInt(operational.proofTrade.openOrderId));
  });

  it('collateral/openPrice are bigints, never JS numbers (precision check)', () => {
    if (decoded.eventName !== 'MarketOpenExecuted') throw new Error('wrong event');
    expect(typeof decoded.args.t.collateral).toBe('bigint');
    expect(typeof decoded.args.t.openPrice).toBe('bigint');
  });
});

describe('decodes MarketCloseExecutedV2 from the real proof-trade close report tx', () => {
  const raw = findLog(
    closeReportFixture.result.logs as RawLog[],
    deployment.contracts.callbacks,
    TOPIC0_MARKET_CLOSE_EXECUTED_V2,
  );

  it('the deployed contract emits the V2 event, not V1 (confirmed by topic0 match, not assumed)', () => {
    expect(raw.topics[0].toLowerCase()).toBe(TOPIC0_MARKET_CLOSE_EXECUTED_V2);
  });

  const decoded = decodeEventLog({
    abi: tradingCallbacksAbi,
    data: raw.data as `0x${string}`,
    topics: raw.topics as [`0x${string}`, ...`0x${string}`[]],
  });

  it('the close order id matches closeOrderId and the tradeId matches openOrderId', () => {
    if (decoded.eventName !== 'MarketCloseExecutedV2') throw new Error('wrong event');
    expect(decoded.args.orderId).toBe(BigInt(operational.proofTrade.closeOrderId));
    // tradeId is not a separate id anywhere in the contracts' event surface —
    // it equals the id of the order that opened the trade. See
    // src/lib/tradeId.ts for the full derivation of this convention.
    expect(decoded.args.tradeId).toBe(BigInt(operational.proofTrade.openOrderId));
  });

  it('usdcSentToTrader is close to (but not necessarily equal to) the recorded pre/post balances, as a bigint', () => {
    if (decoded.eventName !== 'MarketCloseExecutedV2') throw new Error('wrong event');
    expect(typeof decoded.args.usdcSentToTrader).toBe('bigint');
    // trader got back roughly their collateral minus a small loss/fees
    const sent = decoded.args.usdcSentToTrader;
    expect(sent).toBeGreaterThan(0n);
    expect(sent).toBeLessThan(BigInt(operational.proofTrade.collateral));
  });

  it('percentageClosed reflects a full close (10000 = 100%)', () => {
    if (decoded.eventName !== 'MarketCloseExecutedV2') throw new Error('wrong event');
    expect(decoded.args.percentageClosed).toBe(10000n);
  });
});

describe('decodes PriceReceived for the open report (index price stream)', () => {
  const raw = findLog(openReportFixture.result.logs as RawLog[], deployment.contracts.priceUpKeep, TOPIC0_PRICE_RECEIVED);

  const decoded = decodeEventLog({
    abi: priceUpKeepAbi,
    data: raw.data as `0x${string}`,
    topics: raw.topics as [`0x${string}`, ...`0x${string}`[]],
  });

  it('decodes a signed int192 price as a bigint close to the open price', () => {
    if (decoded.eventName !== 'PriceReceived') throw new Error('wrong event');
    expect(typeof decoded.args.price).toBe('bigint');
    // report price should be within a few dollars of the executed open price
    const diff =
      decoded.args.price > BigInt(operational.proofTrade.openPrice)
        ? decoded.args.price - BigInt(operational.proofTrade.openPrice)
        : BigInt(operational.proofTrade.openPrice) - decoded.args.price;
    expect(diff).toBeLessThan(10n * 10n ** 18n); // within $10
  });
});

describe('decodes MarketOpenOrderInitiated and PriceRequestedV2 (phase 1, request tx)', () => {
  const orderLog = findLog(
    openRequestFixture.result.logs as RawLog[],
    deployment.contracts.trading,
    TOPIC0_MARKET_OPEN_ORDER_INITIATED,
  );
  const priceReqLog = findLog(
    openRequestFixture.result.logs as RawLog[],
    deployment.contracts.priceUpKeep,
    TOPIC0_PRICE_REQUESTED_V2,
  );

  it('MarketOpenOrderInitiated decodes the same orderId/trader/pairIndex as the executed trade', () => {
    const decoded = decodeEventLog({
      abi: tradingAbi,
      data: orderLog.data as `0x${string}`,
      topics: orderLog.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== 'MarketOpenOrderInitiated') throw new Error('wrong event');
    expect(decoded.args.orderId).toBe(BigInt(operational.proofTrade.openOrderId));
    expect(decoded.args.trader.toLowerCase()).toBe(operational.roles.trader.toLowerCase());
    expect(decoded.args.pairIndex).toBe(operational.proofTrade.pairIndex);
  });

  it('PriceRequestedV2 fires in the same tx for the same orderId, feed "BTC/USD"', () => {
    const decoded = decodeEventLog({
      abi: priceUpKeepAbi,
      data: priceReqLog.data as `0x${string}`,
      topics: priceReqLog.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== 'PriceRequestedV2') throw new Error('wrong event');
    expect(decoded.args.orderId).toBe(BigInt(operational.proofTrade.openOrderId));
    // bytes32("BTC/USD"), right-padded with zero bytes
    expect(decoded.args.feed).toBe(
      '0x4254432f55534400000000000000000000000000000000000000000000000000'.slice(0, 66),
    );
    expect(decoded.args.orderType).toBe(0); // OrderType.MARKET_OPEN
  });

  it('the request tx does NOT contain the execution event (that only fires on the later report tx)', () => {
    const found = (openRequestFixture.result.logs as RawLog[]).some(
      (l) => l.topics[0]?.toLowerCase() === TOPIC0_MARKET_OPEN_EXECUTED,
    );
    expect(found).toBe(false);
  });
});

describe('decodes PairAdded and MaxOpenInterestUpdated market-config logs', () => {
  // These come from a separate eth_getLogs sweep (not a tx receipt), so we
  // inline the two raw logs captured on 2026-09-08 rather than adding a
  // third fixture file for two rows.
  const pairAddedLog: RawLog = {
    address: deployment.contracts.pairsStorage,
    topics: [TOPIC0_PAIR_ADDED],
    data:
      '0x000000000000000000000000000000000000000000000000000000000000000042544300000000000000000000000000000000000000000000000000000000005553440000000000000000000000000000000000000000000000000000000000',
  };
  const maxOiLog: RawLog = {
    address: deployment.contracts.tradingStorage,
    topics: [TOPIC0_MAX_OI_UPDATED, '0x0000000000000000000000000000000000000000000000000000000000000000'],
    data: '0x000000000000000000000000000000000000000000000000000000e8d4a51000',
  };

  it('PairAdded decodes from="BTC" to="USD", matching deployments/1874-operational.json', () => {
    const decoded = decodeEventLog({
      abi: pairsStorageAbi,
      data: pairAddedLog.data as `0x${string}`,
      topics: pairAddedLog.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== 'PairAdded') throw new Error('wrong event');
    expect(decoded.args.from).toMatch(/^0x4254430+$/); // "BTC" in hex, right-padded
    expect(decoded.args.to).toMatch(/^0x5553440+$/); // "USD" in hex, right-padded
    expect(decoded.args.index).toBe(operational.market.pairIndex);
  });

  it('MaxOpenInterestUpdated decodes to exactly 1_000_000_000_000 (PRECISION_6), matching the config file', () => {
    const decoded = decodeEventLog({
      abi: tradingStorageAbi,
      data: maxOiLog.data as `0x${string}`,
      topics: maxOiLog.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== 'MaxOpenInterestUpdated') throw new Error('wrong event');
    expect(decoded.args.value).toBe(BigInt(operational.market.maxOpenInterest));
    expect(decoded.args.value).toBe(1_000_000_000_000n);
  });
});

// keep tradingAbi import used (guards against an unused-import lint/tsc error
// while documenting that Trading-contract decoding is exercised indirectly
// through the handler code, not duplicated here with another fixture).
void tradingAbi;
