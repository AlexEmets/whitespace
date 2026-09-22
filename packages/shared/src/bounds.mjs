/**
 * Named, single-source-of-truth bounds for the price pipeline.
 *
 * Source: docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md §5.2, the
 * "Initial parameter values" table. These are explicitly starting points to be tuned
 * against measured data — every one of them must stay a named constant here, never a
 * magic number at its use site.
 *
 * Two groups:
 *  - PUBLISHER_BOUNDS are enforced by services/price-publisher — the tuned filter.
 *  - CONTRACT_BOUNDS are enforced on-chain by the verifier/upkeep — the backstop. They
 *    are captured here for reference only (so operators reason about both layers
 *    together); this package does not and cannot enforce them.
 */

/** A venue tick older than this is rejected. */
export const VENUE_STALENESS_BOUND_MS = 2_000;

/** A venue whose (ask-bid)/mid spread exceeds this many bps is rejected. */
export const VENUE_SPREAD_WIDTH_BOUND_BPS = 10n;

/** A venue whose mid deviates from the median of the *other* healthy venues by more
 * than this many bps is rejected. */
export const VENUE_DEVIATION_BOUND_BPS = 50n;

/** Below this many healthy venues the market enters degraded mode: closes allowed,
 * opens blocked. */
export const MIN_HEALTHY_VENUES = 3;

/** Mark price = EMA(index) over this window, so a single tick cannot trigger a
 * liquidation cascade. */
export const MARK_EMA_WINDOW_MS = 10_000;

/** How often the publisher samples the current index into the mark EMA. Combined with
 * MARK_EMA_WINDOW_MS this determines the EMA's smoothing factor (alpha = 2/(N+1),
 * N = window/interval) — see services/price-publisher/src/ema.mjs. */
export const MARK_EMA_SAMPLE_INTERVAL_MS = 1_000;

export const PUBLISHER_BOUNDS = {
  stalenessBoundMs: VENUE_STALENESS_BOUND_MS,
  spreadWidthBoundBps: VENUE_SPREAD_WIDTH_BOUND_BPS,
  deviationBoundBps: VENUE_DEVIATION_BOUND_BPS,
  minHealthyVenues: MIN_HEALTHY_VENUES,
  markEmaWindowMs: MARK_EMA_WINDOW_MS,
  markEmaSampleIntervalMs: MARK_EMA_SAMPLE_INTERVAL_MS,
};

/**
 * Per-market deviations from PUBLISHER_BOUNDS, keyed by feed name. A market absent here
 * — which is every market unless stated otherwise — gets PUBLISHER_BOUNDS unchanged.
 *
 * This exists so one thin market cannot force a global loosening. Lowering
 * MIN_HEALTHY_VENUES itself, or widening VENUE_SPREAD_WIDTH_BOUND_BPS to admit a wide
 * venue, would weaken BTC/ETH/SOL to accommodate a market none of them have anything to
 * do with. Overrides are deliberately narrow: state the market, the bound, and why.
 *
 * WBT/USD — `stalenessBoundMs: 8_000`.
 *   VENUE_STALENESS_BOUND_MS is 2 s, and every book on every venue breaches it routinely:
 *   measured over 120 s on 2026-09-22, BTC_USDT exceeded 2 s between depth updates 11
 *   times (max 4,483 ms), WBT_USDT 17 times (max 4,685 ms), WBT_PERP 19 times (max
 *   5,548 ms). A four-venue market absorbs that — losing one source still leaves three —
 *   so the bound has always been survivable rather than accurate. A two-source market has
 *   no such slack: at 2 s, WBT sat degraded in 26 of ~100 samples, and occasionally at
 *   zero healthy sources with both books merely quiet.
 *
 *   The bound conflates "this book has not changed" with "this feed is dead". A book that
 *   has not ticked still has a live best bid/ask — `depth_update` only fires on a change —
 *   so for a market that simply trades less often, 2 s rejects good quotes. Dead
 *   connections are caught by a different mechanism entirely: the WS layer pings every 8 s
 *   and terminates a socket silent for 20 s (services/price-publisher/src/venues/index.mjs).
 *
 *   8 s sits above the observed maximum with headroom and below that 20 s watchdog, so a
 *   genuinely dead socket still goes stale here before it is reconnected. Zero gaps over
 *   10 s were observed on any book. Raising this globally instead would loosen the filter
 *   for the four-venue markets, which do not need it and whose redundancy is what makes a
 *   tight bound affordable there.
 *
 * WBT/USD — `minHealthyVenues: 2`.
 *   WBT is quoted inside the spread bound on WhiteBIT alone (see ./markets.mjs for the
 *   2026-09-22 measurements that rule out Binance/Bybit/OKX/MEXC/Kraken), so it is fed by
 *   that exchange's two independent books, WBT_USDT and WBT_PERP.
 *
 *   Two, not one, because at a threshold of 1 the aggregator's leave-one-out deviation
 *   check silently stops doing anything: with a single healthy source the "others" pool
 *   is empty and the tick is accepted unchecked (aggregator.mjs classifyVenues), leaving
 *   only staleness and spread between a glitched book and the signed price. At 2, the two
 *   books police each other, and a divergence past VENUE_DEVIATION_BOUND_BPS rejects both
 *   — which yields noData and no report, the safe failure.
 *
 *   Accepted risk: this is book-level redundancy, not venue-level. One operator, one API
 *   host. If WhiteBIT itself is wrong, both books are wrong together and nothing off-chain
 *   catches it — the only backstop left is the on-chain CONTRACT_MAX_DEVIATION_BPS (500),
 *   50x looser than the publisher's own filter. That is why WBT is listed with a lower
 *   leverage ceiling and a smaller open-interest cap than the four-venue markets.
 *
 * @type {Record<string, Partial<typeof PUBLISHER_BOUNDS>>}
 */
export const MARKET_BOUNDS_OVERRIDES = {
  'WBT/USD': { minHealthyVenues: 2, stalenessBoundMs: 8_000 },
};

/**
 * The bounds that apply to one feed: PUBLISHER_BOUNDS, with any MARKET_BOUNDS_OVERRIDES
 * entry merged over it. Always returns a complete bounds object, so callers never have to
 * know whether a market is special.
 *
 * @param {string} feed e.g. 'BTC/USD'
 * @returns {typeof PUBLISHER_BOUNDS}
 */
export function boundsForMarket(feed) {
  const override = MARKET_BOUNDS_OVERRIDES[feed];
  return override ? { ...PUBLISHER_BOUNDS, ...override } : PUBLISHER_BOUNDS;
}

// --- Contract-side (reference only; enforced on-chain, not by this package) ---------

/** Report `maxAge` — reports older than this are rejected on-chain. */
export const CONTRACT_REPORT_MAX_AGE_S = 10;

/** Max deviation (bps) of an incoming report vs the last accepted price, enforced
 * on-chain. */
export const CONTRACT_MAX_DEVIATION_BPS = 500n;

/** Signature threshold: k signatures required, out of N authorized signers. */
export const SIGNATURE_THRESHOLD_K = 3;
export const SIGNATURE_COUNT_N = 5;

/** Market order timeout, in blocks, after which a pending order can be refunded via
 * *TimeoutRefund instead of executed. */
export const CONTRACT_MARKET_ORDERS_TIMEOUT_BLOCKS = 30;

export const CONTRACT_BOUNDS = {
  reportMaxAgeS: CONTRACT_REPORT_MAX_AGE_S,
  maxDeviationBps: CONTRACT_MAX_DEVIATION_BPS,
  signatureThresholdK: SIGNATURE_THRESHOLD_K,
  signatureCountN: SIGNATURE_COUNT_N,
  marketOrdersTimeoutBlocks: CONTRACT_MARKET_ORDERS_TIMEOUT_BLOCKS,
};
