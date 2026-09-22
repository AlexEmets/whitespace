import { queryOne } from '../db.js';
import { price as fmtPrice } from '../format.js';
import { feedNameOf, getPublisherFeed } from '../publisher.js';
import type { RouteResult, Handler } from '../router.js';

type PriceReportRow = { price: string; block_timestamp: number };

/**
 * GET /price/:pairIndex -> { index, mark, updatedAt, healthyVenues, degraded, source }
 *
 * Two sources, in priority order, and the response says which one answered.
 *
 *   "publisher" — the live index and EMA mark, straight from services/price-publisher,
 *     with the real venue health behind them. This is the number the order form quotes
 *     and the keeper signs against, so it is the only correct thing to show a trader
 *     about to open a position.
 *
 *   "chain" — the last signed report that actually landed on chain, from `price_report`.
 *     Used only when the publisher is unreachable. It is not a live price: it is frozen
 *     at the last order and drifts further from the market the longer nobody trades
 *     (measured 517 USD apart when this fallback was still the primary source). Callers
 *     can tell the difference from `source`, and `updatedAt` shows the staleness
 *     directly — nothing here dresses one up as the other.
 *
 * `healthyVenues`/`degraded` stay null on the chain path rather than being guessed: the
 * chain carries no venue-health information, and a fabricated "healthy" is worse than an
 * admitted unknown.
 */
export type PricePayload = {
  index: string | null;
  mark: string | null;
  /** The two-sided quote behind the index. Null on the chain fallback (a settled report
   * carries a single price, not a book) and null whenever the publisher has no two-sided
   * aggregate. A consumer pricing a fill needs to tell "no spread" from "spread unknown",
   * so the mark is never substituted here. */
  bid: string | null;
  ask: string | null;
  updatedAt: number;
  healthyVenues: string[] | null;
  /** How many healthy sources this market needs before opens are allowed. Sent alongside
   * `degraded` so the UI can say what is actually required instead of hardcoding a number
   * that is only right for the four-venue markets. Null on the chain fallback. */
  minHealthyVenues: number | null;
  degraded: boolean | null;
  source: 'publisher' | 'chain';
};

/**
 * The price resolution itself, separated from the HTTP shell so the WebSocket `price:`
 * channel pushes byte-identical payloads to what the REST route returns. When these were
 * two copies of the same query, a change to one silently gave a polling client and a
 * subscribing client different answers for the same market.
 */
export async function resolvePrice(pairIndex: number): Promise<PricePayload | null> {
  const market = await queryOne<{ from_symbol: string; to_symbol: string }>(
    'SELECT from_symbol, to_symbol FROM market WHERE pair_index = $1',
    [pairIndex],
  );

  if (market) {
    const feed = await getPublisherFeed(feedNameOf(market.from_symbol, market.to_symbol));
    // `noData` means the publisher is up but has no venue answering; there is no price
    // to report and falling through to the last on-chain one is the honest move.
    if (feed && !feed.noData && feed.mark !== null && feed.index !== null) {
      return {
        index: fmtPrice(feed.index),
        mark: fmtPrice(feed.mark),
        // `?? null`, not a bare pass-through: a publisher that predates these fields sends
        // `undefined`, and the formatter only short-circuits on `null`. Normalising here
        // keeps a version skew between the two services from becoming a 500.
        bid: fmtPrice(feed.indexBid ?? null),
        ask: fmtPrice(feed.indexAsk ?? null),
        updatedAt: Math.floor(Date.now() / 1000),
        healthyVenues: feed.healthyVenues,
        // Same version-skew reasoning as bid/ask above: an older publisher omits this, and
        // null is the honest answer — better than asserting a global default that would be
        // wrong for exactly the markets this field exists to describe.
        minHealthyVenues: feed.minHealthyVenues ?? null,
        degraded: feed.degraded,
        source: 'publisher',
      };
    }
  }

  const row = await queryOne<PriceReportRow>(
    'SELECT price, block_timestamp FROM price_report WHERE pair_index = $1 ORDER BY block_timestamp DESC, order_id DESC LIMIT 1',
    [pairIndex],
  );
  if (!row) return null;
  return {
    index: fmtPrice(row.price),
    mark: fmtPrice(row.price),
    // A settled on-chain report is one number. There is no bid or ask to recover from it.
    bid: null,
    ask: null,
    updatedAt: row.block_timestamp,
    healthyVenues: null,
    minHealthyVenues: null,
    degraded: null,
    source: 'chain',
  };
}

export const handlePrice: Handler = async (_req, params): Promise<RouteResult> => {
  const pairIndex = Number(params.pairIndex);
  if (!Number.isInteger(pairIndex)) {
    return { code: 400, body: { error: 'invalid pairIndex' } };
  }
  const payload = await resolvePrice(pairIndex);
  if (!payload) {
    return { code: 404, body: { error: 'no price available: publisher unreachable and no price reports indexed' } };
  }
  return { code: 200, body: payload };
};
