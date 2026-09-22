import type { MarketSummary } from './types';

/**
 * How a market is named on screen.
 *
 * terminal_design.pdf labels every market `BTC-PERP`, not `BTC-USD`. That is a display
 * convention rather than a licence to invent: these ARE perpetual contracts with no
 * expiry, so `-PERP` describes the instrument more precisely than the quote asset does.
 * The chain's own `from`/`to` are untouched — only the label changes, and `to` is still
 * what every price on the screen is denominated in.
 *
 * Centralised because the `${from}-${to}` pattern was duplicated across six components
 * and only two of them carried the `#pairIndex` fallback, so an unlisted market rendered
 * as `undefined-undefined` in the other four.
 */
export function marketLabel(market: { from: string } | undefined, pairIndex?: number): string {
  if (!market) return pairIndex === undefined ? '—' : `#${pairIndex}`;
  return `${market.from}-PERP`;
}

/** The same label, looked up by pair index. */
export function marketLabelByIndex(pairIndex: number, markets: MarketSummary[]): string {
  return marketLabel(
    markets.find((m) => m.pairIndex === pairIndex),
    pairIndex,
  );
}

/** `BTC-USD`, for the places that must state the quote asset explicitly — the market
 * registry table and anywhere the pair's denomination is the point. */
export function marketPairLabel(market: { from: string; to: string } | undefined, pairIndex?: number): string {
  if (!market) return pairIndex === undefined ? '—' : `#${pairIndex}`;
  return `${market.from}-${market.to}`;
}
