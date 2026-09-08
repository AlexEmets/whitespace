/**
 * Live implementations of the reader functions services/liquidator/src/liquidatorEngine.mjs
 * needs, wired to real viem `readContract` calls and the price-publisher's HTTP API. Not
 * unit-tested here (network) — the decision logic these feed is fully tested against
 * mocks in test/liquidatorEngine.test.mjs; this module is the thin, deliberately dumb
 * translation from "the contract's own view" to plain JS values.
 */

import { TRADING_STORAGE_ABI, PAIR_INFOS_ABI, PAIRS_STORAGE_ABI } from './abi.mjs';
import { getMarketByFeedId } from '@whitespace/shared/markets';

/**
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.publicClient
 * @param {`0x${string}`} opts.tradingStorageAddress
 * @param {`0x${string}`} opts.pairInfosAddress
 * @param {`0x${string}`} opts.pairsStorageAddress
 * @param {string} opts.publisherBaseUrl
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createChainReader({
  publicClient,
  tradingStorageAddress,
  pairInfosAddress,
  pairsStorageAddress,
  publisherBaseUrl,
  fetchImpl = fetch,
}) {
  const feedCache = new Map(); // pairIndex -> feed name

  async function resolveFeed(pairIndex) {
    if (feedCache.has(pairIndex)) return feedCache.get(pairIndex);
    const feedId = await publicClient.readContract({
      address: pairsStorageAddress,
      abi: PAIRS_STORAGE_ABI,
      functionName: 'pairFeed',
      args: [pairIndex],
    });
    const market = getMarketByFeedId(feedId);
    if (!market) throw new Error(`resolveFeed: pairIndex ${pairIndex} feed ${feedId} is not in @whitespace/shared/markets`);
    feedCache.set(pairIndex, market.feed);
    return market.feed;
  }

  /**
   * @param {`0x${string}`} trader
   * @param {number} pairIndex
   * @param {number} index
   */
  async function readTrade(trader, pairIndex, index) {
    const trade = await publicClient.readContract({
      address: tradingStorageAddress,
      abi: TRADING_STORAGE_ABI,
      functionName: 'getOpenTrade',
      args: [trader, pairIndex, index],
    });
    if (trade.leverage === 0n) return null; // slot not open -- see liquidatorEngine.mjs

    const [tradeInfo, rolloverFee, fundingFeeResult] = await Promise.all([
      publicClient.readContract({
        address: tradingStorageAddress,
        abi: TRADING_STORAGE_ABI,
        functionName: 'getOpenTradeInfo',
        args: [trader, pairIndex, index],
      }),
      publicClient.readContract({
        address: pairInfosAddress,
        abi: PAIR_INFOS_ABI,
        functionName: 'getTradeRolloverFee',
        args: [trader, pairIndex, index, trade.buy, trade.collateral, trade.leverage],
      }),
      publicClient.readContract({
        address: pairInfosAddress,
        abi: PAIR_INFOS_ABI,
        functionName: 'getTradeFundingFee',
        args: [trader, pairIndex, index, trade.buy, trade.collateral, trade.leverage],
      }),
    ]);

    return {
      collateral: trade.collateral,
      leverage: trade.leverage,
      openPrice: trade.openPrice,
      buy: trade.buy,
      initialLeverage: tradeInfo.initialLeverage,
      rolloverFee,
      fundingFee: fundingFeeResult[0],
    };
  }

  /** TradingCallbacksLib.getEffectiveMaxLeverage, mirrored via two view calls instead of
   * replayed off-chain (both are cheap, ungoverned-by-fee-accrual reads). */
  async function readMaxLeverage(pairIndex, isDayTrade) {
    const [pairMax, overnightMax] = await Promise.all([
      publicClient.readContract({ address: pairsStorageAddress, abi: PAIRS_STORAGE_ABI, functionName: 'pairMaxLeverage', args: [pairIndex] }),
      publicClient.readContract({ address: pairsStorageAddress, abi: PAIRS_STORAGE_ABI, functionName: 'pairOvernightMaxLeverage', args: [pairIndex] }),
    ]);
    return isDayTrade ? pairMax : overnightMax > 0n ? overnightMax : pairMax;
  }

  async function readLiqMarginThresholdP() {
    const value = await publicClient.readContract({ address: pairInfosAddress, abi: PAIR_INFOS_ABI, functionName: 'liqMarginThresholdP' });
    return BigInt(value);
  }

  async function fetchStatus() {
    const res = await fetchImpl(new URL('/status', publisherBaseUrl));
    if (!res.ok) throw new Error(`publisher /status returned ${res.status}`);
    return res.json();
  }

  /** The trusted index/mark price — same basis the publisher will sign into a report
   * for this feed (services/price-publisher/src/engine.mjs's `mark`, an EMA of the
   * index; see design spec §5.2). */
  async function readIndexPrice(pairIndex) {
    const feed = await resolveFeed(pairIndex);
    const { feeds } = await fetchStatus();
    const snap = feeds[feed];
    if (!snap || snap.mark === null || snap.mark === undefined) {
      throw new Error(`readIndexPrice: no mark price available for ${feed}`);
    }
    return BigInt(snap.mark);
  }

  async function readHealthyVenueCount(pairIndex) {
    const feed = await resolveFeed(pairIndex);
    const { feeds } = await fetchStatus();
    return feeds[feed]?.healthyCount ?? 0;
  }

  return { readTrade, readMaxLeverage, readLiqMarginThresholdP, readIndexPrice, readHealthyVenueCount, resolveFeed };
}
