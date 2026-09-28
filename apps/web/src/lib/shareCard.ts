import { explainCloseReason, type ClosedTrade } from './closedTrade';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from './config';
import { collateralToRaw, formatMoney, leverageToRaw } from './money';
import { estimateUnrealisedPnl } from './pnl';
import type { Theme } from './theme';
import type { PositionSummary } from './types';

/**
 * The "share your PnL" card: what a trade looks like on the image a trader posts to X.
 *
 * Plain module (no 'use client'): the same model feeds the in-app share dialog and the
 * server route that renders the PNG, so the picture and the page can never disagree.
 * Every figure is formatted through src/lib/money.ts from the API's own strings.
 */
export interface ShareCard {
  status: 'open' | 'closed';
  /** "BTC-PERP" */
  market: string;
  side: 'long' | 'short';
  /** "10×" */
  leverage: string;
  entry: string;
  /** The close price for a closed trade, the mark for an open one. */
  exit: string;
  exitLabel: 'Exit' | 'Mark';
  /** "+12.50 USDW" */
  pnl: string;
  /** Return on the margin put up: "+12.50%". */
  roe: string;
  positive: boolean;
  /** "Take profit", "Stop loss", "Liquidated" — null for an ordinary close. */
  reason: string | null;
  /** "50% closed" for a partial close. */
  partial: string | null;
  /** UTC day of the close (or of the snapshot, for an open position): "28 Sep 2026". */
  date: string;
}

export type ShareRef = { kind: 'closed'; closeOrderId: string } | { kind: 'open'; tradeId: string };

/** PnL as a share of the margin, in hundredths of a percent (1250n = 12.50%). Bigint
 * division truncates toward zero, so a loss is never rounded into a smaller one. */
export function roeBps(pnlRaw: bigint, collateralRaw: bigint): bigint {
  if (collateralRaw === 0n) return 0n;
  return (pnlRaw * 10_000n) / collateralRaw;
}

/** "10.00" → "10×", "12.50" → "12.5×": leverage as a trader says it. */
export function compactLeverage(leverage: string): string {
  const fixed = formatMoney(leverageToRaw(leverage), 2, { grouping: false, fractionDigits: 2 });
  return `${fixed.replace(/\.?0+$/, '')}×`;
}

/* Spelled out rather than taken from Intl: ICU versions disagree on short month names
   ("Sep" vs "Sept"), and the server that renders the image and the browser that shows the
   dialog must print the same date. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Reasons worth printing on a card. An ordinary close by the trader says nothing. */
const CARD_REASONS = new Set(['tp', 'sl', 'liq']);

function money(raw: bigint): string {
  return `${formatMoney(raw, COLLATERAL_DECIMALS, { signDisplay: true })} USDW`;
}

function percent(bps: bigint): string {
  return `${formatMoney(bps, 2, { signDisplay: true, grouping: false })}%`;
}

/**
 * The card for one close. Null when the row is missing the figures the card is made of —
 * a card that printed "—" where its PnL should be is not worth posting.
 */
export function closedTradeShareCard(trade: ClosedTrade, marketFrom: string): ShareCard | null {
  if (trade.realisedPnlRaw === null || trade.closePrice === null) return null;
  const pnl = trade.realisedPnlRaw;
  const roe = roeBps(pnl, collateralToRaw(trade.collateral));
  const reason = trade.closeReason && CARD_REASONS.has(trade.closeReason) ? explainCloseReason(trade.closeReason) : null;
  const partial =
    trade.isPartial && trade.percentageClosed
      ? `${formatMoney(leverageToRaw(trade.percentageClosed), 2, { grouping: false, fractionDigits: 2 }).replace(/\.?0+$/, '')}% closed`
      : null;

  return {
    status: 'closed',
    market: `${marketFrom}-PERP`,
    side: trade.buy ? 'long' : 'short',
    leverage: compactLeverage(trade.leverage),
    entry: formatMoney(trade.openPrice, PRICE_DECIMALS_NUM),
    exit: formatMoney(trade.closePrice, PRICE_DECIMALS_NUM),
    exitLabel: 'Exit',
    pnl: money(pnl),
    roe: percent(roe),
    positive: pnl >= 0n,
    reason,
    partial,
    date: utcDate(trade.closedAt ?? trade.openedAt),
  };
}

/** The card for a position still open, marked to `markPrice` at `nowSeconds`. */
export function openPositionShareCard(
  position: PositionSummary,
  marketFrom: string,
  markPrice: string,
  nowSeconds: number,
): ShareCard {
  const pnl = estimateUnrealisedPnl({
    collateral: position.collateral,
    leverage: position.leverage,
    openPrice: position.openPrice,
    markPrice,
    buy: position.buy,
  });
  return {
    status: 'open',
    market: `${marketFrom}-PERP`,
    side: position.buy ? 'long' : 'short',
    leverage: compactLeverage(position.leverage),
    entry: formatMoney(position.openPrice, PRICE_DECIMALS_NUM),
    exit: formatMoney(markPrice, PRICE_DECIMALS_NUM),
    exitLabel: 'Mark',
    pnl: money(pnl),
    roe: percent(roeBps(pnl, collateralToRaw(position.collateral))),
    positive: pnl >= 0n,
    reason: null,
    partial: null,
    date: utcDate(nowSeconds),
  };
}

export function shareId(ref: ShareRef): string {
  return ref.kind === 'closed' ? `c${ref.closeOrderId}` : `o${ref.tradeId}`;
}

/** Strictly a kind letter and up to 30 digits — the id is a path segment the server feeds
 * into an API lookup, so nothing else gets through. */
export function parseShareId(id: string): ShareRef | null {
  const match = /^([co])(\d{1,30})$/.exec(id);
  if (!match) return null;
  return match[1] === 'c' ? { kind: 'closed', closeOrderId: match[2]! } : { kind: 'open', tradeId: match[2]! };
}

/** A close can be shared only by its own close-order id; a row whose key had to be
 * synthesised (an API that did not send `closeOrderId`) has no stable link. */
export function closedShareRef(trade: ClosedTrade): ShareRef | null {
  return /^\d{1,30}$/.test(trade.rowKey) ? { kind: 'closed', closeOrderId: trade.rowKey } : null;
}

export function isAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function sharePath(address: string, ref: ShareRef, theme?: Theme): string {
  const path = `/share/${address.toLowerCase()}/${shareId(ref)}`;
  return theme === 'lunar' ? `${path}?t=lunar` : path;
}

/** The card PNG that a share page previews (app/share/[address]/[id]/card.png). */
export function shareImagePath(address: string, ref: ShareRef, theme?: Theme): string {
  const path = `/share/${address.toLowerCase()}/${shareId(ref)}/card.png`;
  return theme === 'lunar' ? `${path}?t=lunar` : path;
}

export function shareText(card: ShareCard): string {
  return card.status === 'closed'
    ? `Closed a ${card.leverage} ${card.side} on ${card.market} at ${card.roe} on Whitespace testnet`
    : `Riding a ${card.leverage} ${card.side} on ${card.market}, ${card.roe} so far, on Whitespace testnet`;
}

/** X's compose intent. X cannot attach an image from a link, so the image travels as the
 * link's preview card (see app/share). */
export function xIntentUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/tweet?${params.toString()}`;
}
