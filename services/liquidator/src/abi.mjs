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
  'function hasOpenLimitOrder(address trader, uint16 pairIndex, uint8 index) view returns (bool)',
  // OpenLimitOrder; orderType is IOstiumTradingStorage.OpenOrderType (MARKET=0, LIMIT=1, STOP=2).
  'function getOpenLimitOrder(address trader, uint16 pairIndex, uint8 index) view returns ((uint256 collateral, uint192 targetPrice, uint192 tp, uint192 sl, address trader, uint32 leverage, uint32 createdAt, uint32 lastUpdated, uint16 pairIndex, uint8 orderType, uint8 index, bool buy, bool isDayTrade))',
  'function getBuilderData(address trader, uint16 pairIndex, uint256 index) view returns ((address builder, uint32 builderFee))',
  'function orderTriggerBlock(address trader, uint16 pairIndex, uint8 index, uint8 orderType) view returns (uint256)',
]);

/** OstiumTrading: the pending-trigger window executeAutomationOrder enforces
 * (TradingLib.checkNoPendingTrigger). */
export const TRADING_ABI = parseAbi(['function triggerTimeout() view returns (uint16)']);

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
  // Inputs to TradingCallbacksLib.getDynamicTradePriceImpact / calculatePostFeeCollateral.
  'function pairDynamicSpreadParams(uint16) view returns (uint256 netVolThreshold, uint128 decayRate, uint256 priceImpactK)',
  'function pairDynamicSpreadState(uint16) view returns (uint256 buyVolume, uint256 sellVolume, uint32 lastUpdateTimestamp)',
  'function pairOpeningFees(uint16) view returns (uint32 makerFeeP, uint32 takerFeeP, uint32 usageFeeP, uint16 utilizationThresholdP, uint16 makerMaxLeverage, uint8 vaultFeePercent)',
]);

/** IOstiumPairsStorage: effective max leverage resolution (TradingCallbacksLib.getEffectiveMaxLeverage). */
export const PAIRS_STORAGE_ABI = parseAbi([
  'function pairMaxLeverage(uint16) view returns (uint32)',
  'function pairOvernightMaxLeverage(uint16) view returns (uint32)',
  'function oracle(uint16) view returns (string)',
  'function pairFeed(uint16) view returns (bytes32)',
  'function pairOracleFee(uint16) view returns (uint64)',
]);

/** IOstiumAutomationCompatible / IOstiumForwarded, as implemented by OstiumTradesUpKeep
 * (deployed by the testnet redeploy; its address is required by config.mjs).
 * LimitOrder enum order matches IOstiumTradingStorage.sol: TP=0, SL=1, LIQ=2, OPEN=3,
 * CLOSE_DAY_TRADE=4, REMOVE_COLLATERAL=5, PENDING_CLOSE=6. */
export const TRADES_UPKEEP_ABI = parseAbi([
  'function performUpkeep(bytes performData)',
  'function isForwarder(address) view returns (bool)',
  'error NotForwarder(address a)',
  'error NotGov(address a)',
  'error WrongParams()',
]);

/** IOstiumTradingStorage.OpenOrderType */
export const OpenOrderType = Object.freeze({ MARKET: 0, LIMIT: 1, STOP: 2 });

export const LimitOrder = Object.freeze({
  TP: 0,
  SL: 1,
  LIQ: 2,
  OPEN: 3,
  CLOSE_DAY_TRADE: 4,
  REMOVE_COLLATERAL: 5,
  PENDING_CLOSE: 6,
});
