/**
 * Ties the pure aggregator + EMA to per-feed state and produces signed v2 reports.
 * No network I/O here — `ingestTick` is called by the venue WS layer in production and
 * directly by tests otherwise, so the whole signing pipeline is unit-testable without
 * a socket.
 */

import { computeIndex, canSignForOrderType } from './aggregator.mjs';
import { createMarkEma } from './ema.mjs';
import { buildReportDataV2, signAndEncodeReportV2 } from '@whitespace/reporter/report-v2';
import { getMarket } from '@whitespace/shared/markets';
import { weightOf } from '@whitespace/shared/venues';

/**
 * @param {object} opts
 * @param {number} opts.chainId
 * @param {`0x${string}`} opts.verifierAddress
 * @param {string[]} opts.markets feed names this engine tracks, e.g. ['BTC/USD','ETH/USD']
 * @param {import('@whitespace/shared/bounds').PUBLISHER_BOUNDS} opts.bounds default bounds
 * @param {(feed: string) => typeof opts.bounds} [opts.boundsFor] per-feed bounds resolver;
 *        defaults to "every feed gets `bounds`". Production passes `boundsForMarket` so a
 *        market with a MARKET_BOUNDS_OVERRIDES entry is judged by its own thresholds.
 * @param {{ address: `0x${string}`, privateKey: `0x${string}` }[]} opts.signerKeys
 * @param {number} opts.signatureThresholdK
 * @param {() => number} [opts.now]
 * @param {number} [opts.markStalenessMs] a mark not moved by a real index sample for
 *        longer than this is stale: reported as such, never signed, and reseeded from the
 *        next index. Default: MARK_STALE_SAMPLES sample intervals of the feed.
 */
/** Default mark staleness bound, in sample intervals. One or two missed samples are
 * jitter; three in a row means the index is gone. */
export const MARK_STALE_SAMPLES = 3;

/**
 * How long a feed must be continuously below its healthy-venue minimum before opens are
 * refused, once it has been healthy. Without it `degraded` was recomputed from scratch on
 * every request, so one venue tick landing a few ms past the staleness bound flipped a
 * single request to `degraded_opens_blocked` and the next one back — traders saw opens
 * fail at random on a market that was, by any sensible reading, fine. Two sample intervals:
 * long enough to ride out a late tick, far too short to trade on a real venue loss.
 *
 * Deliberately one-sided. Recovery is immediate, and the grace never applies to a feed
 * that has not yet been healthy (startup) or to `noData` (nothing to price with at all).
 */
export const DEFAULT_DEGRADED_ENTER_GRACE_MS = 2_000;

export function createPublisherEngine({
  chainId,
  verifierAddress,
  markets,
  bounds,
  boundsFor = () => bounds,
  signerKeys,
  signatureThresholdK,
  now = () => Date.now(),
  markStalenessMs,
  degradedEnterGraceMs = DEFAULT_DEGRADED_ENTER_GRACE_MS,
}) {
  // Bounds are resolved ONCE per feed and stored beside that feed's ticks, rather than
  // looked up at each use. There is exactly one place the index is computed
  // (`currentAggregate`), and everything else — sampleMark, signReportFor, /status,
  // /health — reads through it, so pinning the bounds here is what makes the whole
  // service per-market without any other call site knowing about it.
  const state = new Map();
  for (const feed of markets) {
    const feedBounds = boundsFor(feed);
    state.set(feed, {
      ticks: new Map(),
      bounds: feedBounds,
      /** When a real (non-null) index last moved the mark. */
      markUpdatedAt: null,
      staleAfterMs: markStalenessMs ?? MARK_STALE_SAMPLES * feedBounds.markEmaSampleIntervalMs,
      /** The degraded verdict after hysteresis; starts degraded until proven healthy. */
      degraded: true,
      /** When the raw aggregate first said degraded while the feed was still healthy. */
      degradedSince: null,
      ema: createMarkEma({
        windowMs: feedBounds.markEmaWindowMs,
        sampleIntervalMs: feedBounds.markEmaSampleIntervalMs,
      }),
    });
  }

  function requireFeed(feed) {
    const s = state.get(feed);
    if (!s) throw new Error(`unknown feed "${feed}"`);
    return s;
  }

  /** @param {string} feed @param {{venue:string,bid:bigint,ask:bigint,ts:number}} tick */
  function ingestTick(feed, tick) {
    requireFeed(feed).ticks.set(tick.venue, tick);
  }

  /** @param {string} feed @param {number} [at] */
  function currentAggregate(feed, at = now()) {
    const s = requireFeed(feed);
    return withDegradedHysteresis(s, computeIndex([...s.ticks.values()], at, s.bounds, weightOf), at);
  }

  /** See DEFAULT_DEGRADED_ENTER_GRACE_MS. `rawDegraded` keeps the instantaneous verdict
   * visible to anyone diagnosing a flap. */
  function withDegradedHysteresis(s, aggregate, at) {
    const rawDegraded = aggregate.degraded;
    if (aggregate.noData) {
      s.degraded = true;
      s.degradedSince = null;
    } else if (!rawDegraded) {
      s.degraded = false;
      s.degradedSince = null;
    } else if (!s.degraded) {
      if (s.degradedSince === null) s.degradedSince = at;
      if (at - s.degradedSince >= degradedEnterGraceMs) {
        s.degraded = true;
        s.degradedSince = null;
      }
    }
    return { ...aggregate, degraded: s.degraded, rawDegraded };
  }

  /** Advances the mark EMA by one sample from the current index. Called on a fixed
   * timer in production (main.mjs); called directly with an explicit `at` in tests. */
  function sampleMark(feed, at = now()) {
    const s = requireFeed(feed);
    const aggregate = currentAggregate(feed, at);
    let reseeded = false;
    if (aggregate.index !== null) {
      // After a stale gap the old mark is a price from before the outage. Blending the
      // first new index into it would drag the mark back toward that price for a whole
      // window; start again from the market instead, exactly as at startup.
      if (s.markUpdatedAt !== null && at - s.markUpdatedAt > s.staleAfterMs) {
        s.ema.reset();
        reseeded = true;
      }
      s.ema.update(aggregate.index);
      s.markUpdatedAt = at;
    }
    // A null index leaves the value alone (one missed sample must not poison it) but
    // does not refresh its age either, so a long gap shows up as a stale mark.
    return { aggregate, mark: s.ema.value, reseeded, ...markStatus(feed, at) };
  }

  function markOf(feed) {
    return requireFeed(feed).ema.value;
  }

  /** @returns {{ mark: bigint|null, markAgeMs: number|null, stale: boolean, staleAfterMs: number }} */
  function markStatus(feed, at = now()) {
    const s = requireFeed(feed);
    const markAgeMs = s.markUpdatedAt === null ? null : at - s.markUpdatedAt;
    const stale = s.ema.value === null || markAgeMs === null || markAgeMs > s.staleAfterMs;
    return { mark: s.ema.value, markAgeMs, stale, staleAfterMs: s.staleAfterMs };
  }

  function markStalenessMsOf(feed) {
    return requireFeed(feed).staleAfterMs;
  }

  /**
   * Builds and signs a v2 report for `feed`, at the caller-supplied `timestamp` (must
   * be byte-identical to the order's PriceRequestedV2 log — this function does not
   * default to Date.now() anywhere), gated on whether the current aggregate permits
   * signing for `orderTypeName`. Returns { ok: false, reason } instead of a report
   * when the gate fails — the do-not-sign path never has a signedReport in it.
   *
   * @param {string} feed
   * @param {number} timestamp uint32 seconds, from the order's log — verbatim
   * @param {string} orderTypeName e.g. 'MARKET_OPEN'
   * @param {{ isMarketOpen?: boolean, isDayTradingClosed?: boolean }} [opts]
   */
  async function signReportFor(feed, timestamp, orderTypeName, opts = {}) {
    const { isMarketOpen = true, isDayTradingClosed = false } = opts;
    const s = requireFeed(feed);
    const aggregate = currentAggregate(feed);

    const gate = canSignForOrderType(orderTypeName, aggregate);
    if (!gate.ok) return { ok: false, reason: gate.reason, aggregate };

    const mark = s.ema.value;
    if (mark === null) return { ok: false, reason: 'no_mark_yet', aggregate };
    if (markStatus(feed).stale) return { ok: false, reason: 'mark_stale', aggregate };

    if (signerKeys.length < signatureThresholdK) {
      return { ok: false, reason: 'insufficient_signer_keys', aggregate };
    }

    const market = getMarket(feed);
    const reportData = buildReportDataV2({
      chainId,
      verifier: verifierAddress,
      feedId: market.feedId,
      timestamp,
      price: mark,
      bid: aggregate.indexBid ?? mark,
      ask: aggregate.indexAsk ?? mark,
      isMarketOpen,
      isDayTradingClosed,
    });
    const { signedReport, signers } = await signAndEncodeReportV2(
      reportData,
      signerKeys.map((k) => k.privateKey),
    );
    return { ok: true, signedReport, signers, aggregate, mark, reportData };
  }

  function snapshot(feed) {
    const s = requireFeed(feed);
    return { feed, ticks: [...s.ticks.values()], mark: s.ema.value };
  }

  return {
    now,
    markets: [...state.keys()],
    ingestTick,
    currentAggregate,
    sampleMark,
    markOf,
    markStatus,
    markStalenessMsOf,
    signReportFor,
    snapshot,
  };
}
