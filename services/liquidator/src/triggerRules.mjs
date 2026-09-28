/**
 * Exact trigger rules for every automation order type the bot fires through
 * OstiumTradesUpKeep.performUpkeep -> OstiumTrading.executeAutomationOrder. Each rule is
 * the callback's own hit condition, with the callback's own choice of price. Pure; no
 * I/O. Line references are to contracts/src/vendor/ostium/.
 *
 * The report the keeper delivers carries three prices (services/price-publisher
 * engine.signReportFor): `price` = the publisher's mark, `bid`/`ask` = the aggregated
 * index quote (falling back to the mark when a side is missing). A `market` snapshot
 * here is exactly those three numbers plus the pair's dynamic-spread state.
 *
 * CLOSE side — OstiumTradingCallbacks.executeAutomationCloseOrderCallback (:499-608):
 *   isMarketPrice = orderType in {LIQ, SL}                                    (:534-535)
 *   LIQ  hit  <=> tradeValue < liqMarginValue at `price`                     (:546, lib :411-414)
 *   SL   hit  <=> sl > 0 && (buy ? price <= sl : price >= sl)                (lib :419-422, price = a.price)
 *   TP   hit  <=> tp > 0 && (buy ? pai >= tp : pai <= tp)                    (lib :415-418)
 *        where pai = getDynamicTradePriceImpact(price, ask, bid, isOpen=false, t, collateral)
 *        (lib :278-279) — the fill price after impact: bid for a long / ask for a short
 *        when priceImpactK == 0.
 *
 * OPEN side — executeAutomationOpenOrderCallback (:402-497), getAutomationOpenOrderCancelReason
 * (lib :354-398):
 *   LIMIT hit <=> buy ? pai <= target : pai >= target                        (lib :364-365)
 *   STOP  hit <=> buy ? price >= target : price <= target                    (lib :364-366, price = a.price)
 *        where pai = getDynamicTradePriceImpact(price, ask, bid, isOpen=true, o,
 *        calculatePostFeeCollateral(o.collateral, ...))                      (:444-450)
 *   and even when hit, the fill is cancelled if the fill price already crosses the
 *   order's own TP or SL (lib :370-378); the bot treats that as not triggerable.
 *
 * Any report with price, bid or ask <= 0 is cancelled MARKET_CLOSED (:414-418, :521-523).
 */

import { getTradeLiquidationMargin, currentPercentProfit, getTradeValuePure, isLiquidatable } from './marginEngine.mjs';
import { getDynamicTradePriceImpact, calculatePostFeeCollateral } from './priceImpact.mjs';

export const TriggerKind = Object.freeze({ TP: 'TP', SL: 'SL', LIQ: 'LIQ', OPEN: 'OPEN' });

/** @param {{ price: bigint, bid: bigint, ask: bigint }} m */
export function isTradeableQuote(m) {
  return m.price > 0n && m.bid > 0n && m.ask > 0n;
}

/** lib :419-422, compared against the raw report price. */
export function isSlHit({ sl, buy, price }) {
  return sl > 0n && (buy ? price <= sl : price >= sl);
}

/** lib :415-418, compared against the close fill price after impact. */
export function isTpHit({ tp, buy, priceAfterImpact }) {
  return tp > 0n && (buy ? priceAfterImpact >= tp : priceAfterImpact <= tp);
}

/** lib :364-368 */
export function isOpenOrderHit({ orderType, buy, targetPrice, price, priceAfterImpact }) {
  if (orderType === 'LIMIT') return buy ? priceAfterImpact <= targetPrice : priceAfterImpact >= targetPrice;
  if (orderType === 'STOP') return buy ? price >= targetPrice : price <= targetPrice;
  throw new Error(`isOpenOrderHit: unknown orderType ${orderType}`);
}

/** lib :370-378. Returns the cancel reason the callback would give, or null. */
export function openOrderTpSlReached({ tp, sl, buy, priceAfterImpact }) {
  if (tp !== 0n && (buy ? priceAfterImpact >= tp : priceAfterImpact <= tp)) return 'TP_REACHED';
  if (sl !== 0n && (buy ? priceAfterImpact <= sl : priceAfterImpact >= sl)) return 'SL_REACHED';
  return null;
}

/**
 * Decides every close-side trigger for one open trade at one market snapshot.
 *
 * @param {object} p
 * @param {{ collateral: bigint, leverage: bigint, openPrice: bigint, buy: boolean,
 *           tp: bigint, sl: bigint, initialLeverage: bigint,
 *           rolloverFee: bigint, fundingFee: bigint }} p.trade live chain state
 * @param {{ price: bigint, bid: bigint, ask: bigint, impact: object }} p.market
 * @param {bigint} p.maxLeverage effective max leverage for this trade's isDayTrade
 * @param {bigint} p.liqMarginThresholdP
 * @param {bigint} p.blockTimestamp
 */
export function evaluateCloseTriggers({ trade, market, maxLeverage, liqMarginThresholdP, blockTimestamp }) {
  const liqMarginValue = getTradeLiquidationMargin({
    collateral: trade.collateral,
    leverage: trade.leverage,
    maxLeverage,
    liqMarginThresholdP,
  });
  const { p: percentProfit } = currentPercentProfit({
    openPrice: trade.openPrice,
    currentPrice: market.price,
    buy: trade.buy,
    leverage: trade.leverage,
    initialLeverage: trade.initialLeverage,
  });
  const tradeValue = getTradeValuePure({
    collateral: trade.collateral,
    percentProfit,
    rolloverFee: trade.rolloverFee,
    fundingFee: trade.fundingFee,
  });

  const { priceAfterImpact } = getDynamicTradePriceImpact({
    price: market.price,
    ask: market.ask,
    bid: market.bid,
    isOpen: false,
    buy: trade.buy,
    collateral: trade.collateral,
    leverage: trade.leverage,
    impact: market.impact,
    blockTimestamp,
  });

  return {
    liq: isLiquidatable(tradeValue, liqMarginValue),
    sl: isSlHit({ sl: trade.sl, buy: trade.buy, price: market.price }),
    tp: isTpHit({ tp: trade.tp, buy: trade.buy, priceAfterImpact }),
    tradeValue,
    liqMarginValue,
    closePriceAfterImpact: priceAfterImpact,
  };
}

/**
 * Decides whether a resting LIMIT/STOP entry fills at one market snapshot.
 *
 * @param {object} p
 * @param {{ orderType: 'LIMIT'|'STOP', buy: boolean, targetPrice: bigint, tp: bigint, sl: bigint,
 *           collateral: bigint, leverage: bigint }} p.order live chain state
 * @param {{ price: bigint, bid: bigint, ask: bigint, impact: object }} p.market
 * @param {{ takerFeeP: bigint, oracleFee: bigint, builder: string, builderFee: bigint }} p.fees
 * @param {bigint} p.blockTimestamp
 * @returns {{ hit: boolean, reason?: string, priceAfterImpact?: bigint }}
 */
export function evaluateOpenTrigger({ order, market, fees, blockTimestamp }) {
  const postFeeCollateral = calculatePostFeeCollateral({ collateral: order.collateral, leverage: order.leverage, ...fees });
  if (postFeeCollateral === null) return { hit: false, reason: 'fees_exceed_collateral' };

  const { priceAfterImpact } = getDynamicTradePriceImpact({
    price: market.price,
    ask: market.ask,
    bid: market.bid,
    isOpen: true,
    buy: order.buy,
    collateral: postFeeCollateral,
    leverage: order.leverage,
    impact: market.impact,
    blockTimestamp,
  });

  if (!isOpenOrderHit({ ...order, price: market.price, priceAfterImpact })) {
    return { hit: false, reason: 'not_hit', priceAfterImpact };
  }
  const tpSl = openOrderTpSlReached({ tp: order.tp, sl: order.sl, buy: order.buy, priceAfterImpact });
  if (tpSl) return { hit: false, reason: tpSl, priceAfterImpact };
  return { hit: true, priceAfterImpact };
}
