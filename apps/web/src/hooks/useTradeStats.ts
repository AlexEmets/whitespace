'use client';

import { useMemo } from 'react';
import { COLLATERAL_DECIMALS, LEVERAGE_DECIMALS } from '@/lib/config';
import { collateralToRaw, leverageToRaw } from '@/lib/money';
import type { ClosedPositionSummary, PositionSummary } from '@/lib/types';
import { usePositionHistory } from './usePositionHistory';

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

export interface TradeStats {
  trades: ClosedTrade[];
  closedCount: number;
  /** Sum of every closed trade's realised PnL, raw 6-decimal. `null` if ANY row was
   * missing its PnL — a total computed over a subset is not the total. */
  realisedPnlRaw: bigint | null;
  /** Sum of opening notional across closed trades, raw 6-decimal. */
  closedNotionalRaw: bigint;
  /** Distinct pairIndex count across closed rows. */
  marketsTraded: number;
  wins: number;
  losses: number;
  firstClosedAt: number | null;
  lastClosedAt: number | null;
}

/** Pure aggregation over already-normalised trades — exported so the arithmetic can be
 * unit-tested without React or a network. */
export function summariseClosedTrades(trades: ClosedTrade[]): TradeStats {
  let realisedPnlRaw: bigint | null = 0n;
  let closedNotionalRaw = 0n;
  let wins = 0;
  let losses = 0;
  let firstClosedAt: number | null = null;
  let lastClosedAt: number | null = null;
  const markets = new Set<number>();

  for (const trade of trades) {
    closedNotionalRaw += trade.notionalRaw;
    markets.add(trade.pairIndex);

    if (trade.realisedPnlRaw === null) {
      realisedPnlRaw = null;
    } else {
      if (realisedPnlRaw !== null) realisedPnlRaw += trade.realisedPnlRaw;
      if (trade.realisedPnlRaw > 0n) wins += 1;
      else if (trade.realisedPnlRaw < 0n) losses += 1;
    }

    if (trade.closedAt !== null) {
      if (firstClosedAt === null || trade.closedAt < firstClosedAt) firstClosedAt = trade.closedAt;
      if (lastClosedAt === null || trade.closedAt > lastClosedAt) lastClosedAt = trade.closedAt;
    }
  }

  return {
    trades,
    closedCount: trades.length,
    realisedPnlRaw: trades.length === 0 ? 0n : realisedPnlRaw,
    closedNotionalRaw,
    marketsTraded: markets.size,
    wins,
    losses,
    firstClosedAt,
    lastClosedAt,
  };
}

export interface MarketTradeStats {
  pairIndex: number;
  closedCount: number;
  notionalRaw: bigint;
  realisedPnlRaw: bigint | null;
}

/** Per-market split of the same closed trades, for the activity breakdown on /points.
 * Sorted by traded notional, descending. */
export function groupByMarket(trades: ClosedTrade[]): MarketTradeStats[] {
  const byMarket = new Map<number, MarketTradeStats>();
  for (const trade of trades) {
    const entry = byMarket.get(trade.pairIndex) ?? {
      pairIndex: trade.pairIndex,
      closedCount: 0,
      notionalRaw: 0n,
      realisedPnlRaw: 0n as bigint | null,
    };
    entry.closedCount += 1;
    entry.notionalRaw += trade.notionalRaw;
    if (trade.realisedPnlRaw === null) entry.realisedPnlRaw = null;
    else if (entry.realisedPnlRaw !== null) entry.realisedPnlRaw += trade.realisedPnlRaw;
    byMarket.set(trade.pairIndex, entry);
  }
  return [...byMarket.values()].sort((a, b) => (b.notionalRaw > a.notionalRaw ? 1 : b.notionalRaw < a.notionalRaw ? -1 : 0));
}

/** Sum of opening notional across currently-open positions, raw 6-decimal. */
export function openNotionalRaw(positions: PositionSummary[]): bigint {
  return positions.reduce((total, p) => total + notionalRaw(p.collateral, p.leverage), 0n);
}

/** Sum of collateral locked in currently-open positions, raw 6-decimal. */
export function lockedCollateralRaw(positions: PositionSummary[]): bigint {
  return positions.reduce((total, p) => total + collateralToRaw(p.collateral), 0n);
}

export { COLLATERAL_DECIMALS };

/**
 * Closed-trade history for `address`, normalised and aggregated. Backs the realised-PnL
 * and trade-history sections of /portfolio and every personal figure on /points — both
 * read the same numbers from the same source, so the two pages can never disagree.
 */
export function useTradeStats(address: `0x${string}` | undefined): {
  stats: TradeStats;
  loading: boolean;
  error: Error | null;
} {
  const { history, loading, error } = usePositionHistory(address);
  const stats = useMemo(() => summariseClosedTrades(history.map(toClosedTrade)), [history]);
  return { stats, loading, error };
}
