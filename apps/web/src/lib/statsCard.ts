import type { ClosedTrade } from './closedTrade';
import { COLLATERAL_DECIMALS } from './config';
import { formatCompactMoney, formatMoney } from './money';
import { cumulativeRealisedPnl, winRate } from './portfolio';
import { utcDate } from './shareCard';
import type { Theme } from './theme';

/**
 * The "share your stats" card: a wallet's whole record on one image — realised PnL, win
 * rate, trades, volume and the best trade — the way a trade card shows one close.
 *
 * Plain module (no 'use client'): the portfolio's share dialog and the server route that
 * renders the PNG build the card from the same closes through this one function, so the
 * picture and the page cannot disagree. Every figure is formatted through money.ts.
 */
export interface StatsCard {
  /** "0x2f78…e865" */
  wallet: string;
  /** Realised PnL, signed, without the unit: "+1,234.56". */
  pnl: string;
  positive: boolean;
  /** "64%", or "—" when no close has decided a win or a loss. */
  winRate: string;
  /** "18W · 10L" */
  record: string;
  /** Closes, partial ones included: "28". */
  trades: string;
  /** Opening notional of every close, compact: "412.3K". */
  volume: string;
  /** The best single close, signed: "+512.30". */
  best: string;
  /** "BTC-PERP" */
  bestMarket: string;
  /** Running realised PnL in USDW, oldest close first from zero — display only. */
  series: number[];
  /** UTC day the card was made: "03 Nov 2026". */
  date: string;
}

/** The most points the card's PnL curve keeps; a long history is thinned to this. */
const MAX_SERIES_POINTS = 48;

const signed = (raw: bigint) => formatMoney(raw, COLLATERAL_DECIMALS, { signDisplay: true });

/** Evenly spaced picks from a series, always keeping its first and last point. */
function thin<T>(values: T[], max: number): T[] {
  if (values.length <= max) return values;
  return Array.from({ length: max }, (_, i) => values[Math.round((i * (values.length - 1)) / (max - 1))]!);
}

/**
 * The card for a wallet's closes, as the API sends them (newest first). Null when there is
 * nothing to show — no closes — or when any close is missing its PnL: a total over part of
 * the closes is not the total, and a card is a claim someone will post.
 */
export function traderStatsCard(
  address: string,
  trades: ClosedTrade[],
  marketFrom: (pairIndex: number) => string | null,
  nowSeconds: number,
): StatsCard | null {
  if (trades.length === 0 || trades.some((t) => t.realisedPnlRaw === null)) return null;

  let total = 0n;
  let volume = 0n;
  let wins = 0;
  let losses = 0;
  let best = trades[0]!;
  for (const trade of trades) {
    const pnl = trade.realisedPnlRaw!;
    total += pnl;
    volume += trade.notionalRaw;
    if (pnl > 0n) wins += 1;
    else if (pnl < 0n) losses += 1;
    if (pnl > best.realisedPnlRaw!) best = trade;
  }

  const rate = winRate(wins, losses);
  const series = cumulativeRealisedPnl(trades) ?? [];
  const lower = address.toLowerCase();
  const from = marketFrom(best.pairIndex);

  return {
    wallet: `${lower.slice(0, 6)}…${lower.slice(-4)}`,
    pnl: signed(total),
    positive: total >= 0n,
    winRate: rate === null ? '—' : `${Math.round(rate * 100)}%`,
    record: `${wins}W · ${losses}L`,
    trades: String(trades.length),
    volume: formatCompactMoney(volume, COLLATERAL_DECIMALS),
    best: signed(best.realisedPnlRaw!),
    bestMarket: from ? `${from}-PERP` : `Market #${best.pairIndex}`,
    series: thin(series, MAX_SERIES_POINTS).map((v) => Number(v) / 10 ** COLLATERAL_DECIMALS),
    date: utcDate(nowSeconds),
  };
}

/** The page a shared stats link opens (app/share/[address]/stats). */
export function statsSharePath(address: string, theme?: Theme): string {
  const path = `/share/${address.toLowerCase()}/stats`;
  return theme === 'lunar' ? `${path}?t=lunar` : path;
}

/** The stats card PNG (app/share/[address]/stats/card.png). */
export function statsImagePath(address: string, theme?: Theme): string {
  const path = `/share/${address.toLowerCase()}/stats/card.png`;
  return theme === 'lunar' ? `${path}?t=lunar` : path;
}

export function statsShareText(card: StatsCard): string {
  const trades = `${card.trades} ${card.trades === '1' ? 'trade' : 'trades'}`;
  const rate = card.winRate === '—' ? '' : ` with a ${card.winRate} win rate`;
  return `${card.pnl} USDW realised over ${trades}${rate} on Whitespace testnet`;
}

/**
 * The PnL curve as an SVG path in a `width`×`height` box: points spread evenly across the
 * width, the highest at the top. Display-only float maths — it draws a line, it prints no
 * number. Null for fewer than two points, which make no line.
 */
export function sparkPath(values: number[], width: number, height: number): string | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const y = (v: number) => (max === min ? height / 2 : height - ((v - min) / (max - min)) * height);
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i * width) / (values.length - 1)).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
}
