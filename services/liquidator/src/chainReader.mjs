/**
 * Live readers the automation engine needs: contract views via viem `readContract`, and
 * the price-publisher's `/status` for the prices a report will carry. Deliberately dumb
 * translation from "the contract's own view" to plain JS values; every decision lives in
 * automationEngine.mjs / triggerRules.mjs.
 *
 * viem decodes uint8..uint48 as `number` and wider ints as `bigint`. Everything that
 * feeds bigint maths is normalised with BigInt() here — `getOpenTrade().leverage` is a
 * uint32, so comparing it to `0n` without normalising never matches.
 */

import { TRADING_STORAGE_ABI, PAIR_INFOS_ABI, PAIRS_STORAGE_ABI, TRADING_ABI, OpenOrderType } from './abi.mjs';
import { getMarketByFeedId } from '@whitespace/shared/markets';
import { MIN_HEALTHY_VENUES } from '@whitespace/shared/bounds';

const OPEN_ORDER_TYPE_NAME = { [OpenOrderType.LIMIT]: 'LIMIT', [OpenOrderType.STOP]: 'STOP' };

/**
 * The prices a report for `feed` would carry right now, exactly as
 * services/price-publisher engine.signReportFor builds them: price = mark,
 * bid/ask = aggregated index quote, each side falling back to the mark when missing.
 * @param {{ mark?: string|null, indexBid?: string|null, indexAsk?: string|null,
 *           healthyCount?: number, minHealthyVenues?: number } | undefined} snap
 */
export function quoteFromStatus(snap) {
  if (!snap || snap.mark === null || snap.mark === undefined) return null;
  const price = BigInt(snap.mark);
  return {
    price,
    bid: snap.indexBid === null || snap.indexBid === undefined ? price : BigInt(snap.indexBid),
    ask: snap.indexAsk === null || snap.indexAsk === undefined ? price : BigInt(snap.indexAsk),
    healthyVenueCount: snap.healthyCount ?? 0,
    // Older publishers omit it; the global minimum can only be stricter than the truth.
    minHealthyVenues: snap.minHealthyVenues ?? MIN_HEALTHY_VENUES,
  };
}

/**
 * executeAutomationOrder returns PENDING_TRIGGER while
 * `triggerBlock != 0 && block.number - triggerBlock < triggerTimeout`
 * (TradingLib.checkNoPendingTrigger). Our tx lands in the next block at the earliest.
 * @param {bigint} triggerBlock @param {bigint} headBlock @param {bigint} triggerTimeout
 */
export function isTriggerPending(triggerBlock, headBlock, triggerTimeout) {
  if (triggerBlock === 0n) return false;
  return headBlock + 1n - triggerBlock < triggerTimeout;
}

/**
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.publicClient
 * @param {`0x${string}`} opts.tradingStorageAddress
 * @param {`0x${string}`} opts.pairInfosAddress
 * @param {`0x${string}`} opts.pairsStorageAddress
 * @param {`0x${string}`} opts.tradingAddress
 * @param {string} opts.publisherBaseUrl
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createChainReader({
  publicClient,
  tradingStorageAddress,
  pairInfosAddress,
  pairsStorageAddress,
  tradingAddress,
  publisherBaseUrl,
  fetchImpl = fetch,
}) {
  const feedCache = new Map(); // pairIndex -> feed name
  const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
  const storage = (fn, args) => read(tradingStorageAddress, TRADING_STORAGE_ABI, fn, args);
  const infos = (fn, args) => read(pairInfosAddress, PAIR_INFOS_ABI, fn, args);
  const pairs = (fn, args) => read(pairsStorageAddress, PAIRS_STORAGE_ABI, fn, args);

  async function resolveFeed(pairIndex) {
    if (feedCache.has(pairIndex)) return feedCache.get(pairIndex);
    const feedId = await pairs('pairFeed', [pairIndex]);
    const market = getMarketByFeedId(feedId);
    if (!market) throw new Error(`resolveFeed: pairIndex ${pairIndex} feed ${feedId} is not in @whitespace/shared/markets`);
    feedCache.set(pairIndex, market.feed);
    return market.feed;
  }

  /** One /status fetch per sweep; quotes for any pair resolve against it. */
  async function readPriceSnapshot() {
    const res = await fetchImpl(new URL('/status', publisherBaseUrl));
    if (!res.ok) throw new Error(`publisher /status returned ${res.status}`);
    const { feeds } = await res.json();
    return {
      async quoteFor(pairIndex) {
        const feed = await resolveFeed(pairIndex);
        const quote = quoteFromStatus(feeds?.[feed]);
        if (!quote) throw new Error(`no mark price available for ${feed}`);
        return quote;
      },
    };
  }

  /** Live trade + exact fee snapshot, or null when the slot is not open. */
  async function readTrade(trader, pairIndex, index) {
    const trade = await storage('getOpenTrade', [trader, pairIndex, index]);
    const leverage = BigInt(trade.leverage);
    if (leverage === 0n) return null;
    const collateral = BigInt(trade.collateral);

    const [info, rolloverFee, funding] = await Promise.all([
      storage('getOpenTradeInfo', [trader, pairIndex, index]),
      infos('getTradeRolloverFee', [trader, pairIndex, index, trade.buy, collateral, Number(leverage)]),
      infos('getTradeFundingFee', [trader, pairIndex, index, trade.buy, collateral, Number(leverage)]),
    ]);

    return {
      tradeId: BigInt(info.tradeId),
      collateral,
      leverage,
      openPrice: BigInt(trade.openPrice),
      tp: BigInt(trade.tp),
      sl: BigInt(trade.sl),
      buy: trade.buy,
      isDayTrade: trade.isDayTrade,
      initialLeverage: BigInt(info.initialLeverage),
      createdAt: Number(info.createdAt),
      tpLastUpdated: Number(info.tpLastUpdated),
      slLastUpdated: Number(info.slLastUpdated),
      rolloverFee: BigInt(rolloverFee),
      fundingFee: BigInt(funding[0]),
    };
  }

  /** Live resting LIMIT/STOP entry, or null when the slot holds none. */
  async function readLimitOrder(trader, pairIndex, index) {
    if (!(await storage('hasOpenLimitOrder', [trader, pairIndex, index]))) return null;
    const o = await storage('getOpenLimitOrder', [trader, pairIndex, index]);
    const orderType = OPEN_ORDER_TYPE_NAME[Number(o.orderType)];
    if (!orderType) throw new Error(`readLimitOrder: unexpected orderType ${o.orderType}`);
    return {
      orderType,
      buy: o.buy,
      isDayTrade: o.isDayTrade,
      targetPrice: BigInt(o.targetPrice),
      tp: BigInt(o.tp),
      sl: BigInt(o.sl),
      collateral: BigInt(o.collateral),
      leverage: BigInt(o.leverage),
      lastUpdated: Number(o.lastUpdated),
    };
  }

  /** Inputs to calculatePostFeeCollateral for this order (OstiumTradingCallbacks.sol:424, :443-446). */
  async function readOpenFees(trader, pairIndex, index) {
    const [opening, oracleFee, bf] = await Promise.all([
      infos('pairOpeningFees', [pairIndex]),
      pairs('pairOracleFee', [pairIndex]),
      storage('getBuilderData', [trader, pairIndex, BigInt(index)]),
    ]);
    return {
      takerFeeP: BigInt(opening[1]),
      oracleFee: BigInt(oracleFee),
      builder: bf.builder,
      builderFee: BigInt(bf.builderFee),
    };
  }

  /** Dynamic-spread params + state for TradingCallbacksLib.getDynamicTradePriceImpact. */
  async function readImpact(pairIndex) {
    const [params, state] = await Promise.all([infos('pairDynamicSpreadParams', [pairIndex]), infos('pairDynamicSpreadState', [pairIndex])]);
    return {
      netVolThreshold: BigInt(params[0]),
      decayRate: BigInt(params[1]),
      priceImpactK: BigInt(params[2]),
      buyVolume: BigInt(state[0]),
      sellVolume: BigInt(state[1]),
      lastUpdateTimestamp: BigInt(state[2]),
    };
  }

  /** TradingCallbacksLib.getEffectiveMaxLeverage via its two view inputs. */
  async function readMaxLeverage(pairIndex, isDayTrade) {
    const [pairMax, overnightMax] = await Promise.all([pairs('pairMaxLeverage', [pairIndex]), pairs('pairOvernightMaxLeverage', [pairIndex])]);
    const max = BigInt(pairMax);
    const overnight = BigInt(overnightMax);
    return isDayTrade ? max : overnight > 0n ? overnight : max;
  }

  async function readLiqMarginThresholdP() {
    return BigInt(await infos('liqMarginThresholdP'));
  }

  /** @param {number} limitOrder IOstiumTradingStorage.LimitOrder */
  async function readTriggerPending(trader, pairIndex, index, limitOrder) {
    const [triggerBlock, head, timeout] = await Promise.all([
      storage('orderTriggerBlock', [trader, pairIndex, index, limitOrder]),
      publicClient.getBlockNumber(),
      read(tradingAddress, TRADING_ABI, 'triggerTimeout'),
    ]);
    return isTriggerPending(BigInt(triggerBlock), BigInt(head), BigInt(timeout));
  }

  return {
    resolveFeed,
    readPriceSnapshot,
    readTrade,
    readLimitOrder,
    readOpenFees,
    readImpact,
    readMaxLeverage,
    readLiqMarginThresholdP,
    readTriggerPending,
  };
}
