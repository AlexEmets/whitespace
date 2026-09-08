/**
 * ABI fragments mirrored from contracts/src/vendor/ostium/interfaces/*.sol — read-only
 * reference to the contract source; nothing under contracts/ is written by this service.
 * Only the functions/events this service actually calls or watches are included.
 */

import { parseAbi } from 'viem';

/** IOstiumTradingStorage: read live trade state. Struct field order matches
 * IOstiumTradingStorage.sol's Trade/TradeInfo definitions exactly. */
export const TRADING_STORAGE_ABI = parseAbi([
  'function getOpenTrade(address trader, uint16 pairIndex, uint8 index) view returns ((uint256 collateral, uint192 openPrice, uint192 tp, uint192 sl, address trader, uint32 leverage, uint16 pairIndex, uint8 index, bool buy, bool isDayTrade))',
  'function getOpenTradeInfo(address trader, uint16 pairIndex, uint8 index) view returns ((uint256 tradeId, uint256 oiNotional, uint32 initialLeverage, uint32 tpLastUpdated, uint32 slLastUpdated, uint32 createdAt, bool deprecatedBeingMarketClosed))',
]);

/** IOstiumPairInfos: the exact fee/margin view functions — see
 * services/liquidator/src/marginEngine.mjs header note 0/1 for why these are called
 * live rather than replayed off-chain. */
export const PAIR_INFOS_ABI = parseAbi([
  'function liqMarginThresholdP() view returns (uint8)',
  'function getTradeRolloverFee(address trader, uint16 pairIndex, uint8 index, bool long, uint256 collateral, uint32 leverage) view returns (int256)',
  'function getTradeFundingFee(address trader, uint16 pairIndex, uint8 index, bool long, uint256 collateral, uint32 leverage) view returns (int256, int256)',
  // Kept for the monitoring/pre-filter use described in marginEngine.mjs — NOT used to
  // decide whether to submit (see the divergence documented there).
  'function getTradeLiquidationPrice(address trader, uint16 pairIndex, uint8 index, uint256 openPrice, bool long, uint256 collateral, uint32 leverage, uint32 maxLeverage) view returns (uint256)',
]);

/** IOstiumPairsStorage: effective max leverage resolution (TradingCallbacksLib.getEffectiveMaxLeverage). */
export const PAIRS_STORAGE_ABI = parseAbi([
  'function pairMaxLeverage(uint16) view returns (uint32)',
  'function pairOvernightMaxLeverage(uint16) view returns (uint32)',
  'function oracle(uint16) view returns (string)',
  'function pairFeed(uint16) view returns (bytes32)',
]);

/** IOstiumTradingCallbacks events used for candidate discovery (position table) — see
 * services/liquidator/src/positionTable.mjs for why open events are enough (no tradeId
 * correlation needed; every decision re-reads live state keyed by (trader, pairIndex,
 * index)). */
export const CALLBACKS_ABI = parseAbi([
  'event MarketOpenExecuted(uint256 indexed orderId, (uint256 collateral, uint192 openPrice, uint192 tp, uint192 sl, address trader, uint32 leverage, uint16 pairIndex, uint8 index, bool buy, bool isDayTrade) t, uint256 priceImpactP, uint256 tradeNotional)',
  'event LimitOpenExecuted(uint256 indexed orderId, uint256 limitIndex, (uint256 collateral, uint192 openPrice, uint192 tp, uint192 sl, address trader, uint32 leverage, uint16 pairIndex, uint8 index, bool buy, bool isDayTrade) t, uint256 priceImpactP, uint256 tradeNotional)',
]);

/** IOstiumAutomationCompatible / IOstiumForwarded, as implemented by OstiumTradesUpKeep
 * (not yet deployed on 1874 — see config.mjs and docs/decisions/phase-6-liquidator.md).
 * LimitOrder enum order matches IOstiumTradingStorage.sol: TP=0, SL=1, LIQ=2, OPEN=3,
 * CLOSE_DAY_TRADE=4, REMOVE_COLLATERAL=5, PENDING_CLOSE=6. */
export const TRADES_UPKEEP_ABI = parseAbi([
  'function performUpkeep(bytes performData)',
  'function isForwarder(address) view returns (bool)',
  'error NotForwarder(address a)',
  'error NotGov(address a)',
  'error WrongParams()',
]);

export const LimitOrder = Object.freeze({
  TP: 0,
  SL: 1,
  LIQ: 2,
  OPEN: 3,
  CLOSE_DAY_TRADE: 4,
  REMOVE_COLLATERAL: 5,
  PENDING_CLOSE: 6,
});
