import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from './config';
import { formatMoney, parseHumanDecimal } from './money';
import { baseSizeForNotional, collateralForPositionSize } from './pnl';

/**
 * The arithmetic behind the order panel, kept out of the component so every number the trader
 * signs for is unit-tested.
 *
 * The contract takes collateral and leverage (IOstiumTradingStorage.Trade) — there is no size
 * parameter. The panel lets the trader type either the base-asset quantity (BTC) or the USD
 * notional, like Variational's size field with its unit toggle, and converts here.
 *
 * Scales: base size 1e18, prices 1e18, USDW (notional, collateral, fees) 1e6, leverage 1e2.
 */
export type SizeUnit = 'BASE' | 'USD';

const E30 = 10n ** 30n;

export interface TicketInput {
  unit: SizeUnit;
  sizeInput: string;
  leverageRaw: bigint;
  /** The price the order is expected to fill at (quote for MARKET, trigger otherwise). */
  entryPrice: bigint;
  /** PRECISION_6 percent (60_000 == 0.06%). */
  takerFeeRaw: bigint | null;
  /** 1e6 USDW flat per order. */
  oracleFeeRaw: bigint | null;
}

export interface Ticket {
  sizeBaseRaw: bigint;
  notionalRaw: bigint;
  /** What `openTrade` is handed and what leaves the wallet. */
  collateralRaw: bigint;
  /** Opening fee at the taker rate plus the oracle fee, 1e6. Null if either rate is unknown. */
  feeRaw: bigint | null;
}

/** Null when the input does not parse; zeros for an empty field. */
export function computeTicket(t: TicketInput): Ticket | null {
  const empty = t.sizeInput.trim() === '';
  let sizeBaseRaw: bigint;
  let notionalRaw: bigint;
  let collateralRaw: bigint;
  try {
    if (empty) {
      sizeBaseRaw = 0n;
      notionalRaw = 0n;
      collateralRaw = 0n;
    } else if (t.unit === 'BASE') {
      sizeBaseRaw = parseHumanDecimal(t.sizeInput, PRICE_DECIMALS_NUM);
      notionalRaw = t.entryPrice > 0n ? (sizeBaseRaw * t.entryPrice) / E30 : 0n;
      collateralRaw = collateralForPositionSize({
        sizeBaseRaw,
        leverage: t.leverageRaw,
        openPrice: t.entryPrice,
      });
    } else {
      notionalRaw = parseHumanDecimal(t.sizeInput, COLLATERAL_DECIMALS);
      collateralRaw = t.leverageRaw > 0n ? (notionalRaw * 100n) / t.leverageRaw : 0n;
      sizeBaseRaw = baseSizeForNotional(notionalRaw, t.entryPrice);
    }
  } catch {
    return null;
  }
  if (sizeBaseRaw < 0n || notionalRaw < 0n) return null;

  const feeRaw =
    t.takerFeeRaw === null || t.oracleFeeRaw === null
      ? null
      : notionalRaw === 0n
        ? 0n
        : (notionalRaw * t.takerFeeRaw) / 1_000_000n / 100n + t.oracleFeeRaw;

  return { sizeBaseRaw, notionalRaw, collateralRaw, feeRaw };
}

/**
 * The size-field text for `percent` of the available balance used as margin, in the field's
 * current unit. Computed from collateral so 100% can never exceed the balance.
 */
export function sizeForPercentOfBalance(p: {
  percent: number;
  balanceRaw: bigint;
  leverageRaw: bigint;
  entryPrice: bigint;
  unit: SizeUnit;
}): string {
  if (p.percent <= 0 || p.balanceRaw <= 0n || p.entryPrice <= 0n) return '';
  const pct = BigInt(Math.min(100, Math.round(p.percent)));
  const collateral = (p.balanceRaw * pct) / 100n;
  const notional = (collateral * p.leverageRaw) / 100n;
  if (p.unit === 'USD') {
    return formatMoney(notional, COLLATERAL_DECIMALS, { fractionDigits: 2, grouping: false });
  }
  const size = baseSizeForNotional(notional, p.entryPrice);
  return formatMoney(size, PRICE_DECIMALS_NUM, { fractionDigits: 6, grouping: false });
}

/** The same order re-expressed in the other unit, for the unit toggle. */
export function convertSizeInput(t: TicketInput, to: SizeUnit): string {
  if (t.unit === to) return t.sizeInput;
  const ticket = computeTicket(t);
  if (!ticket || t.sizeInput.trim() === '') return '';
  return to === 'USD'
    ? formatMoney(ticket.notionalRaw, COLLATERAL_DECIMALS, { fractionDigits: 2, grouping: false })
    : formatMoney(ticket.sizeBaseRaw, PRICE_DECIMALS_NUM, { fractionDigits: 6, grouping: false });
}

/** Percent of the balance a ticket's margin uses, 0..100+ (for the slider). */
export function percentOfBalance(collateralRaw: bigint, balanceRaw: bigint): number {
  if (balanceRaw <= 0n) return 0;
  return Number((collateralRaw * 10_000n) / balanceRaw) / 100;
}
