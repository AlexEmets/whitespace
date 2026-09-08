import { COLLATERAL_DECIMALS, LEVERAGE_DECIMALS, PRICE_DECIMALS_NUM } from './config';
import { parseRawUnits } from './money';
import type { MoneyInput } from './money';

const LEVERAGE_SCALE = 10n ** BigInt(LEVERAGE_DECIMALS);
const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS_NUM);
const COLLATERAL_TO_PRICE_SCALE_UP = 10n ** BigInt(PRICE_DECIMALS_NUM - COLLATERAL_DECIMALS);

/**
 * Estimated unrealised PnL in collateral (6-decimal) units, computed entirely in bigint.
 *
 * This is a UI estimate only — the authoritative PnL calculation lives on-chain in
 * TradingCallbacksLib (spread, price impact, funding and rollover fees all apply at
 * settlement and are not reproduced here). Never use this value to decide anything other
 * than what to show the trader; the contract is the source of truth for money movement.
 *
 * pnl = collateral * leverage * (markPrice - openPrice) / openPrice, sign-flipped for shorts.
 */
export function estimateUnrealisedPnl(params: {
  collateral: MoneyInput;
  leverage: MoneyInput;
  openPrice: MoneyInput;
  markPrice: MoneyInput;
  buy: boolean;
}): bigint {
  const collateral = parseRawUnits(params.collateral);
  const leverage = parseRawUnits(params.leverage);
  const openPrice = parseRawUnits(params.openPrice);
  const markPrice = parseRawUnits(params.markPrice);

  if (openPrice <= 0n) return 0n;

  // notional, still in 6-decimal collateral units (leverage's 2 implied decimals cancel).
  const notional = (collateral * leverage) / LEVERAGE_SCALE;

  const priceDiff = markPrice - openPrice; // signed, 18-decimal units
  const signedDiff = params.buy ? priceDiff : -priceDiff;

  // (notional * signedDiff / PRICE_SCALE) / openPrice, reordered to keep precision.
  const pnl = (notional * signedDiff) / openPrice;
  return pnl;
}

/**
 * Estimated position size in base-asset units (e.g. BTC), at 18-decimal fixed-point —
 * display only, matching terminal_design.pdf's SIZE column. Never used for a
 * transaction; the contract only ever sees collateral + leverage, never a base-asset
 * quantity. size = notional_usd / openPrice, both converted to the same 18-decimal scale
 * before dividing so the division is exact bigint arithmetic throughout.
 */
export function estimatePositionSizeBase(params: { collateral: MoneyInput; leverage: MoneyInput; openPrice: MoneyInput }): bigint {
  const collateral = parseRawUnits(params.collateral);
  const leverage = parseRawUnits(params.leverage);
  const openPrice = parseRawUnits(params.openPrice);
  if (openPrice <= 0n) return 0n;

  const notional6dec = (collateral * leverage) / LEVERAGE_SCALE;
  const notional18dec = notional6dec * COLLATERAL_TO_PRICE_SCALE_UP;
  return (notional18dec * PRICE_SCALE) / openPrice;
}

export { COLLATERAL_DECIMALS as PNL_DECIMALS };
