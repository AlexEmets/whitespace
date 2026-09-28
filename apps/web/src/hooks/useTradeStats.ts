'use client';

import { useMemo } from 'react';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { collateralToRaw } from '@/lib/money';
import type { PositionSummary } from '@/lib/types';
import { notionalRaw, toClosedTrade, type ClosedTrade } from '@/lib/closedTrade';
import { usePositionHistory } from './usePositionHistory';

export { explainCloseReason, notionalRaw, toClosedTrade } from '@/lib/closedTrade';
export type { ClosedTrade } from '@/lib/closedTrade';

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
