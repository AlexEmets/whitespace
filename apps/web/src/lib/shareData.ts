import { toClosedTrade } from './closedTrade';
import { API_BASE_URL } from './config';
import { closedTradeShareCard, isAddress, openPositionShareCard, parseShareId, type ShareCard } from './shareCard';
import { DEFAULT_THEME, isTheme, type Theme } from './theme';
import type { ClosedPositionSummary, MarketSummary, PositionSummary } from './types';

/** A JSON GET against services/api, by path. Injected so the loader is testable without a
 * network, and so the server can point it at the API directly. */
export type FetchJson = (path: string) => Promise<unknown>;

/**
 * The API as the Next server reaches it. `API_INTERNAL_BASE_URL` lets the host skip the
 * public round trip (http://127.0.0.1:4000 behind Caddy); without it the server uses the
 * same public base URL the browser does.
 */
export function serverApiBase(): string {
  return process.env.API_INTERNAL_BASE_URL ?? API_BASE_URL;
}

export function apiFetchJson(base: string = serverApiBase()): FetchJson {
  return async (path) => {
    const res = await fetch(`${base}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  };
}

export interface ShareCardResult {
  card: ShareCard;
  theme: Theme;
}

/**
 * Everything a share link needs, from the API — never from the link itself, so a card's
 * PnL cannot be forged by editing a URL. Returns null for a malformed address or id (before
 * any request), for a trade this address does not have, for a market with no price, and for
 * an API that did not answer: the page renders a 404, not an error.
 */
export async function loadShareCard(
  params: { address: string; id: string; theme?: string | null },
  fetchJson: FetchJson,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ShareCardResult | null> {
  const ref = parseShareId(params.id);
  if (!isAddress(params.address) || !ref) return null;
  const address = params.address.toLowerCase();
  const theme: Theme = isTheme(params.theme) ? params.theme : DEFAULT_THEME;

  try {
    const markets = (await fetchJson('/markets')) as MarketSummary[];
    const marketFrom = (pairIndex: number) => markets.find((m) => m.pairIndex === pairIndex)?.from ?? null;

    if (ref.kind === 'closed') {
      const history = (await fetchJson(`/positions/${address}/history`)) as ClosedPositionSummary[];
      const trade = history.map(toClosedTrade).find((t) => t.rowKey === ref.closeOrderId);
      const from = trade ? marketFrom(trade.pairIndex) : null;
      if (!trade || !from) return null;
      const card = closedTradeShareCard(trade, from);
      return card ? { card, theme } : null;
    }

    const positions = (await fetchJson(`/positions/${address}`)) as PositionSummary[];
    const position = positions.find((p) => p.tradeId === ref.tradeId);
    const from = position ? marketFrom(position.pairIndex) : null;
    if (!position || !from) return null;
    const price = (await fetchJson(`/price/${position.pairIndex}`)) as { mark?: string | null };
    if (typeof price.mark !== 'string') return null;
    return { card: openPositionShareCard(position, from, price.mark, nowSeconds), theme };
  } catch {
    return null;
  }
}
