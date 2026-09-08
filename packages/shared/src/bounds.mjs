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
