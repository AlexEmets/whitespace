/**
 * The contract's acceptance rules for an order, checked before the wallet is asked to sign one
 * the contract would reject. Every rule cites the line it mirrors; a message says what to change,
 * not what reverted.
 *
 * Scales: prices 1e18, collateral 1e6, leverage 1e2 (1000 == 10.00x).
 */

import type { OpenOrderKind } from './abi';

/** solidity: `MAX_GAIN_P = 900` (OstiumTrading.sol:27) — TP is capped at +900% PnL. */
export const MAX_GAIN_P = 900n;

export interface TpSlInput {
  buy: boolean;
  /** The price the order is expected to open at: the quote for MARKET, the trigger otherwise. */
  entryPrice: bigint;
  /** 0 = none. */
  tp: bigint;
  /** 0 = none. */
  sl: bigint;
}

/**
 * solidity: TradingLib.getOpenTradeRevert — `WrongTP` when a long's TP is not above the
 * entry (short: not below), `WrongSL` when a long's SL is not below it (short: not above).
 * The contract compares against `t.openPrice`, which for a MARKET order is the wanted price
 * the form submits — so validating against the same number is exact.
 */
export function tpSlErrors({ buy, entryPrice, tp, sl }: TpSlInput): { tp: string | null; sl: string | null } {
  let tpError: string | null = null;
  let slError: string | null = null;
  if (tp < 0n) tpError = 'Take profit cannot be negative.';
  else if (tp !== 0n && (buy ? tp <= entryPrice : tp >= entryPrice)) {
    tpError = buy ? 'Take profit must be above the entry price.' : 'Take profit must be below the entry price.';
  }
  if (sl < 0n) slError = 'Stop loss cannot be negative.';
  else if (sl !== 0n && (buy ? sl >= entryPrice : sl <= entryPrice)) {
    slError = buy ? 'Stop loss must be below the entry price.' : 'Stop loss must be above the entry price.';
  }
  return { tp: tpError, sl: slError };
}

/**
 * solidity: OstiumTrading.updateTp — a new TP may not be zero and may not sit further than
 * `openPrice * MAX_GAIN_P / max(initialLeverage, leverage)` beyond the entry.
 */
export function updateTpError(p: {
  buy: boolean;
  openPrice: bigint;
  leverage: bigint;
  initialLeverage: bigint;
  newTp: bigint;
}): string | null {
  if (p.newTp <= 0n) return 'Enter a take-profit price. (A take profit cannot be removed, only moved.)';
  const lev = p.initialLeverage > p.leverage ? p.initialLeverage : p.leverage;
  const maxDist = (p.openPrice * MAX_GAIN_P) / lev;
  if (p.buy && p.newTp > p.openPrice + maxDist) return 'Take profit is beyond the +900% cap for this leverage.';
  if (!p.buy && p.newTp < (maxDist < p.openPrice ? p.openPrice - maxDist : 0n)) {
    return 'Take profit is beyond the +900% cap for this leverage.';
  }
  return null;
}

/**
 * solidity: OstiumTrading.updateSl — zero removes the stop; otherwise it may not sit further
 * than `openPrice * maxSl_P / leverage` from the entry on the losing side.
 */
export function updateSlError(p: {
  buy: boolean;
  openPrice: bigint;
  leverage: bigint;
  maxSlP: bigint;
  newSl: bigint;
}): string | null {
  if (p.newSl < 0n) return 'Stop loss cannot be negative.';
  if (p.newSl === 0n) return null;
  const maxDist = (p.openPrice * p.maxSlP) / p.leverage;
  if (p.buy ? p.newSl < p.openPrice - maxDist : p.newSl > p.openPrice + maxDist) {
    return `Stop loss is further than the ${p.maxSlP}% loss limit allows.`;
  }
  return null;
}

/**
 * A resting entry must be placed where it will wait, not where it fills at once. The contract
 * accepts either, but a LIMIT buy above the market (or a STOP buy below it) triggers on the next
 * automation sweep — almost always a mistake, so the form refuses it.
 *
 * solidity: TradingCallbacksLib.getAutomationOpenOrderCancelReason — LIMIT hits when the fill
 * (after impact) is at/better than the target, STOP when the mark has crossed the target.
 */
export function triggerPriceError(kind: OpenOrderKind, buy: boolean, trigger: bigint, mark: bigint): string | null {
  if (kind === 'MARKET') return null;
  if (trigger <= 0n) return 'Enter a trigger price.';
  if (kind === 'LIMIT' && (buy ? trigger >= mark : trigger <= mark)) {
    return buy ? 'A limit buy must be below the current price.' : 'A limit sell must be above the current price.';
  }
  if (kind === 'STOP' && (buy ? trigger <= mark : trigger >= mark)) {
    return buy ? 'A stop buy must be above the current price.' : 'A stop sell must be below the current price.';
  }
  return null;
}

/**
 * solidity: OstiumTrading.openTrade — `slippageP` must be in (0, 100e2) for MARKET and exactly
 * 0 for LIMIT/STOP, or it reverts `WrongParams`.
 */
export function slippageForSubmission(kind: OpenOrderKind, slippageBps: bigint): bigint {
  if (kind !== 'MARKET') return 0n;
  if (slippageBps <= 0n) return 1n;
  if (slippageBps >= 10_000n) return 9_999n;
  return slippageBps;
}
