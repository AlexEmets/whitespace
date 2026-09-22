import { COLLATERAL_DECIMALS, LEVERAGE_DECIMALS, PRICE_DECIMALS_NUM } from './config';
import { collateralToRaw, leverageToRaw, priceToRaw } from './money';
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
  const collateral = collateralToRaw(params.collateral);
  const leverage = leverageToRaw(params.leverage);
  const openPrice = priceToRaw(params.openPrice);
  const markPrice = priceToRaw(params.markPrice);

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
  const collateral = collateralToRaw(params.collateral);
  const leverage = leverageToRaw(params.leverage);
  const openPrice = priceToRaw(params.openPrice);
  if (openPrice <= 0n) return 0n;

  const notional6dec = (collateral * leverage) / LEVERAGE_SCALE;
  const notional18dec = notional6dec * COLLATERAL_TO_PRICE_SCALE_UP;
  return (notional18dec * PRICE_SCALE) / openPrice;
}

/**
 * The inverse of `estimatePositionSizeBase`: the collateral (6-decimal) that buys
 * `size` of the base asset at `openPrice` and `leverage`.
 *
 * This one is NOT display-only — its result is what gets submitted. The order form is
 * denominated in the base asset because terminal_design.pdf's order panel leads with
 * SIZE, but `openTrade` takes collateral and leverage and has no size parameter at all
 * (IOstiumTradingStorage.Trade). So the field the trader types into is converted here,
 * and the converted figure is surfaced as "Margin required" so the number leaving the
 * wallet is on screen rather than implied.
 *
 * collateral = size * openPrice / leverage, with every scale factor applied as a single
 * multiplication before a single division so no intermediate is truncated.
 *
 * Truncation lands on the trader's side: flooring the collateral buys marginally LESS
 * than the size typed, never more, so this can never overspend a balance the caller has
 * already checked.
 */
export function collateralForPositionSize(params: {
  /** Base-asset quantity at 18-decimal fixed point, as `parseHumanDecimal(x, 18)` returns. */
  sizeBaseRaw: bigint;
  leverage: MoneyInput;
  openPrice: MoneyInput;
}): bigint {
  const leverage = leverageToRaw(params.leverage);
  const openPrice = priceToRaw(params.openPrice);
  if (leverage <= 0n || openPrice <= 0n || params.sizeBaseRaw <= 0n) return 0n;

  const numerator = params.sizeBaseRaw * openPrice * LEVERAGE_SCALE;
  const denominator = PRICE_SCALE * COLLATERAL_TO_PRICE_SCALE_UP * leverage;
  return numerator / denominator;
}

/**
 * Base-asset quantity a given USDW notional buys at `price`, at 18-decimal fixed point.
 *
 * The depth ladder is indexed by NOTIONAL (1k, 5k, 25k… USDW), but terminal_design.pdf's
 * order book denominates its SIZE column in the base asset — `0.3800 BTC`, not `25,000`.
 * This is that conversion, and it is display-only: no transaction is ever sized from it.
 *
 * Scale bookkeeping: `notionalRaw` is 6-decimal USDW and `priceRaw` is 18-decimal, so the
 * notional is widened to 18 decimals first and the multiplication is done before the
 * division, keeping the whole thing exact in bigint.
 */
export function baseSizeForNotional(notionalRaw: bigint, priceRaw: bigint): bigint {
  if (priceRaw <= 0n || notionalRaw <= 0n) return 0n;
  const notional18 = notionalRaw * COLLATERAL_TO_PRICE_SCALE_UP;
  return (notional18 * PRICE_SCALE) / priceRaw;
}

export { COLLATERAL_DECIMALS as PNL_DECIMALS };
