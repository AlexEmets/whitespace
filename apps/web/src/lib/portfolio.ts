import type { ClosedTrade } from './closedTrade';

/**
 * The arithmetic behind /portfolio's overview: how the account value splits across its
 * parts, and what the closed trades add up to. Pure, so every figure the page prints can be
 * checked here without React or a network.
 */

export type AccountPart = 'wallet' | 'margin' | 'unrealised' | 'lp';

/**
 * Each part's share of the account-value bar, 0..1.
 *
 * A bar can only draw what is there. A losing unrealised PnL is not a slice of the account
 * — it is a loss already taken out of the total — so a negative part draws nothing and the
 * positive ones share the full width. The legend beside the bar still prints the signed
 * figure.
 *
 * `null` when any part is unknown: the same rule as the total, since a split over the parts
 * we happen to have would misstate every slice.
 */
export function accountShares(parts: Record<AccountPart, bigint | null>): Record<AccountPart, number> | null {
  const values = Object.values(parts);
  if (values.some((v) => v === null)) return null;

  const positive = (v: bigint | null) => (v !== null && v > 0n ? v : 0n);
  const total = values.reduce<bigint>((sum, v) => sum + positive(v), 0n);
  // Millionths: a 98 USDW margin beside a 19,884 USDW wallet is still a visible sliver.
  const share = (v: bigint | null) => (total === 0n ? 0 : Number((positive(v) * 1_000_000n) / total) / 1_000_000);

  return {
    wallet: share(parts.wallet),
    margin: share(parts.margin),
    unrealised: share(parts.unrealised),
    lp: share(parts.lp),
  };
}

/** Wins over decided closes; a close that broke exactly even decides nothing. */
export function winRate(wins: number, losses: number): number | null {
  const decided = wins + losses;
  return decided === 0 ? null : wins / decided;
}

export interface TradePerformance {
  /** Mean time from open to close, over closes that carry both timestamps. */
  avgHoldSeconds: number | null;
  bestRaw: bigint | null;
  worstRaw: bigint | null;
}

export function tradePerformance(trades: ClosedTrade[]): TradePerformance {
  let holdTotal = 0;
  let holdCount = 0;
  let bestRaw: bigint | null = null;
  let worstRaw: bigint | null = null;

  for (const trade of trades) {
    if (trade.closedAt !== null && trade.closedAt >= trade.openedAt) {
      holdTotal += trade.closedAt - trade.openedAt;
      holdCount += 1;
    }
    const pnl = trade.realisedPnlRaw;
    if (pnl !== null) {
      if (bestRaw === null || pnl > bestRaw) bestRaw = pnl;
      if (worstRaw === null || pnl < worstRaw) worstRaw = pnl;
    }
  }

  return { avgHoldSeconds: holdCount === 0 ? null : holdTotal / holdCount, bestRaw, worstRaw };
}

/**
 * Realised PnL as a running total, oldest close first and starting from zero — the line
 * under the performance card. The API sends closes newest first; closes in the same second
 * keep their on-chain order through the close order id.
 *
 * `null` when a close is missing its PnL: a curve with a hole in it would end on a number
 * that is not the realised total printed above it.
 */
export function cumulativeRealisedPnl(trades: ClosedTrade[]): bigint[] | null {
  if (trades.some((t) => t.realisedPnlRaw === null)) return null;
  if (trades.length === 0) return [];

  const ordered = [...trades].sort((a, b) => {
    const at = a.closedAt ?? Number.POSITIVE_INFINITY;
    const bt = b.closedAt ?? Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return compareRowKeys(a.rowKey, b.rowKey);
  });

  let running = 0n;
  const series = [running];
  for (const trade of ordered) {
    running += trade.realisedPnlRaw!;
    series.push(running);
  }
  return series;
}

/** Close order ids compare as integers ("9" before "11"). A row the API sent without one is
 * keyed `tradeId-pair-index` by toClosedTrade, and those fall back to string order. */
function compareRowKeys(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const ak = BigInt(a);
    const bk = BigInt(b);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
