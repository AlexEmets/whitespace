import { LEVERAGE_DECIMALS } from './config';
import { collateralToRaw, leverageToRaw } from './money';
import type { ClosedPositionSummary } from './types';

/*
 * One closed trade, normalised from GET /positions/:address/history.
 *
 * Plain module (no 'use client') so server code — the /share route that renders a
 * trade's card — can call it. hooks/useTradeStats.ts re-exports everything here.
 */

const LEVERAGE_SCALE = 10n ** BigInt(LEVERAGE_DECIMALS);

/**
 * The fields `GET /positions/:address/history` actually puts on the wire, verified by
 * curl against the running API and against services/api/src/routes/positions.ts:69-86.
 *
 * `src/lib/types.ts`'s `ClosedPositionSummary` declares a required `realisedPnl` — the
 * British spelling. The API never emits that key. It emits `realizedPnl`, plus
 * `closeReason`, `percentProfit` and `usdcSentToTrader`, none of which that interface
 * declares at all. The two were written against the same spec clause and drifted.
 *
 * types.ts is owned elsewhere, so this module reconciles the drift at the boundary
 * instead of editing it: every field below is optional, both spellings of the PnL field
 * are accepted, and anything that is genuinely missing becomes `null` and renders as the
 * app's honest em-dash rather than a zero. A zero here would read as "this trade broke
 * even", which is a different and false claim from "we do not have this figure".
 */
interface ClosedPositionWire {
  realizedPnl?: string;
  realisedPnl?: string;
  usdcSentToTrader?: string;
  closeReason?: string;
  percentProfit?: string;
  closePrice?: string;
  closedAt?: number;
  closeOrderId?: string;
  isPartial?: boolean;
  percentageClosed?: string;
}

/** Human-readable label for `closed_position.close_reason` as the indexer writes it. */
const CLOSE_REASON_LABEL: Record<string, string> = {
  close: 'Closed by trader',
  liq: 'Liquidated',
  tp: 'Take profit',
  sl: 'Stop loss',
};

export function explainCloseReason(reason: string | null): string | null {
  if (!reason) return null;
  return CLOSE_REASON_LABEL[reason] ?? reason;
}

/**
 * One closed trade, normalised. Money stays in the two forms src/lib/money.ts allows —
 * the API's human decimal strings are passed through untouched for display, and the one
 * value this module derives (`realisedPnlRaw`) is an exact 6-decimal bigint.
 */
export interface ClosedTrade {
  pairIndex: number;
  index: number;
  buy: boolean;
  /** Human decimal, 6 fraction digits. */
  collateral: string;
  /** Human decimal, 2 fraction digits. */
  leverage: string;
  /** Human decimal, 18 fraction digits. */
  openPrice: string;
  /** Human decimal, 18 fraction digits — `null` if the API omitted it. */
  closePrice: string | null;
  openedAt: number;
  closedAt: number | null;
  tradeId: string;
  /** Unique per close. A trade closed in parts has one row per part, all sharing `tradeId`. */
  rowKey: string;
  /** True for a partial close; `percentageClosed` is then e.g. "25.00". */
  isPartial: boolean;
  percentageClosed: string | null;
  closeReason: string | null;
  /** Raw 6-decimal signed PnL, or `null` when the wire carried nothing to derive it from. */
  realisedPnlRaw: bigint | null;
  /** Raw 6-decimal opening notional: collateral x leverage. */
  notionalRaw: bigint;
}

/** collateral x leverage in raw 6-decimal collateral units (leverage's 2 implied decimals
 * cancel), the same reduction `src/lib/pnl.ts` performs. Exact bigint throughout. */
export function notionalRaw(collateral: string | bigint, leverage: string | bigint): bigint {
  return (collateralToRaw(collateral) * leverageToRaw(leverage)) / LEVERAGE_SCALE;
}

export function toClosedTrade(raw: ClosedPositionSummary): ClosedTrade {
  const wire = raw as ClosedPositionSummary & ClosedPositionWire;
  const pnlField = wire.realizedPnl ?? wire.realisedPnl;

  // Prefer the API's own field. Fall back to its definition (positions.ts:69,
  // `usdc_sent_to_trader - collateral`) only when the field is absent, so a schema
  // rename cannot silently blank the column. If neither is available, stay null.
  let realisedPnlRaw: bigint | null = null;
  if (typeof pnlField === 'string') {
    realisedPnlRaw = collateralToRaw(pnlField);
  } else if (typeof wire.usdcSentToTrader === 'string') {
    realisedPnlRaw = collateralToRaw(wire.usdcSentToTrader) - collateralToRaw(raw.collateral);
  }

  return {
    pairIndex: raw.pairIndex,
    index: raw.index,
    buy: raw.buy,
    collateral: raw.collateral,
    leverage: raw.leverage,
    openPrice: raw.openPrice,
    closePrice: typeof wire.closePrice === 'string' ? wire.closePrice : null,
    openedAt: raw.openedAt,
    closedAt: typeof wire.closedAt === 'number' ? wire.closedAt : null,
    tradeId: raw.tradeId,
    rowKey: typeof wire.closeOrderId === 'string' ? wire.closeOrderId : `${raw.tradeId}-${raw.pairIndex}-${raw.index}`,
    isPartial: wire.isPartial === true,
    percentageClosed: typeof wire.percentageClosed === 'string' ? wire.percentageClosed : null,
    closeReason: typeof wire.closeReason === 'string' ? wire.closeReason : null,
    realisedPnlRaw,
    notionalRaw: notionalRaw(raw.collateral, raw.leverage),
  };
}
