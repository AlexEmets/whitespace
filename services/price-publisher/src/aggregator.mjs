/**
 * Pure aggregation logic: venue ticks in, index out. No network, no timers, no I/O —
 * everything here is deterministic and unit-testable with synthetic ticks.
 *
 * Pipeline (design spec §5.2):
 *   normalise (mid of best bid/ask) -> outlier rejection -> weighted median = INDEX
 *
 * A venue is rejected if its data is:
 *  - older than the staleness bound,
 *  - wider than the spread-width bound, or
 *  - deviated from the median of the *other* healthy-so-far venues beyond the
 *    deviation bound (leave-one-out: each venue is judged against everyone else, not
 *    against a median that includes itself).
 *
 * Below the minimum healthy-venue count the market is "degraded": there is still an
 * index (as long as at least one venue is healthy), but it must not be used to open
 * new exposure — see canSignForOrderType below, which is the actual do-not-sign gate.
 */

import { PUBLISHER_BOUNDS } from '@whitespace/shared/bounds';
import { bpsOf, deviationBps } from '@whitespace/shared/decimal';

/** @typedef {{ venue: string, bid: bigint, ask: bigint, ts: number }} VenueTick */

/**
 * @param {VenueTick} tick
 * @returns {bigint}
 */
export function midOf(tick) {
  return (tick.bid + tick.ask) / 2n;
}

/**
 * @param {VenueTick} tick
 * @returns {bigint|null} spread in bps, or null if the mid is non-positive
 */
export function spreadBpsOf(tick) {
  const mid = midOf(tick);
  if (mid <= 0n) return null;
  return bpsOf(tick.ask - tick.bid, mid);
}

/**
 * Plain (unweighted) median of a bigint array. Even-length arrays return the lower of
 * the two middle elements — a fixed, deterministic tie-break that never averages two
 * prices into a value neither venue actually quoted.
 * @param {bigint[]} values
 * @returns {bigint|null}
 */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = (sorted.length - 1) >> 1;
  return sorted[mid];
}

/**
 * Weighted median: the smallest value whose cumulative weight (in ascending order)
 * reaches half of the total weight. Reduces to `median()` for equal integer weights.
 * Exact integer comparison (`cumulative * 2n >= totalWeight`) — no rounding.
 * @param {{ value: bigint, weight: bigint }[]} items
 * @returns {bigint|null}
 */
export function weightedMedian(items) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const totalWeight = sorted.reduce((sum, i) => sum + i.weight, 0n);
  if (totalWeight <= 0n) return null;
  let cumulative = 0n;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative * 2n >= totalWeight) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * @param {VenueTick[]} ticks
 * @param {number} now epoch ms
 * @param {typeof PUBLISHER_BOUNDS} bounds
 * @returns {{ healthy: { tick: VenueTick, mid: bigint }[], rejected: { tick: VenueTick, reason: string, detail?: unknown }[] }}
 */
export function classifyVenues(ticks, now, bounds = PUBLISHER_BOUNDS) {
  const rejected = [];
  const candidates = [];

  for (const tick of ticks) {
    const age = now - tick.ts;
    if (age > bounds.stalenessBoundMs) {
      rejected.push({ tick, reason: 'stale', detail: { ageMs: age, boundMs: bounds.stalenessBoundMs } });
      continue;
    }
    if (tick.bid <= 0n || tick.ask <= 0n || tick.ask < tick.bid) {
      rejected.push({ tick, reason: 'invalid_quote', detail: { bid: tick.bid, ask: tick.ask } });
      continue;
    }
    const mid = midOf(tick);
    const spreadBps = spreadBpsOf(tick);
    if (spreadBps === null || spreadBps > bounds.spreadWidthBoundBps) {
      rejected.push({ tick, reason: 'wide_spread', detail: { spreadBps, boundBps: bounds.spreadWidthBoundBps } });
      continue;
    }
    candidates.push({ tick, mid });
  }

  // Leave-one-out deviation check against the pool that already passed staleness and
  // spread filters. A candidate with no peers cannot be judged an outlier in
  // isolation, so it passes through.
  const healthy = [];
  for (const candidate of candidates) {
    const others = candidates.filter((c) => c !== candidate).map((c) => c.mid);
    if (others.length === 0) {
      healthy.push(candidate);
      continue;
    }
    const referenceMedian = median(others);
    const dev = deviationBps(candidate.mid, referenceMedian);
    if (dev === null || dev > bounds.deviationBoundBps) {
      rejected.push({
        tick: candidate.tick,
        reason: 'deviant',
        detail: { deviationBps: dev, referenceMedian, boundBps: bounds.deviationBoundBps },
      });
      continue;
    }
    healthy.push(candidate);
  }

  return { healthy, rejected };
}

/** @typedef {{
 *   index: bigint|null,
 *   indexBid: bigint|null,
 *   indexAsk: bigint|null,
 *   healthyCount: number,
 *   healthyVenues: string[],
 *   minHealthyVenues: number,
 *   rejected: { tick: VenueTick, reason: string, detail?: unknown }[],
 *   degraded: boolean,
 *   noData: boolean,
 * }} IndexResult */

/**
 * @param {VenueTick[]} ticks
 * @param {number} now
 * @param {typeof PUBLISHER_BOUNDS} bounds
 * @param {(venue: string) => bigint} weightOf
 * @returns {IndexResult}
 */
export function computeIndex(ticks, now, bounds = PUBLISHER_BOUNDS, weightOf = () => 1n) {
  const { healthy, rejected } = classifyVenues(ticks, now, bounds);
  const healthyCount = healthy.length;
  const noData = healthyCount === 0;
  const degraded = healthyCount < bounds.minHealthyVenues;

  const index = noData
    ? null
    : weightedMedian(healthy.map((h) => ({ value: h.mid, weight: weightOf(h.tick.venue) })));
  const indexBid = noData
    ? null
    : weightedMedian(healthy.map((h) => ({ value: h.tick.bid, weight: weightOf(h.tick.venue) })));
  const indexAsk = noData
    ? null
    : weightedMedian(healthy.map((h) => ({ value: h.tick.ask, weight: weightOf(h.tick.venue) })));

  return {
    index,
    indexBid,
    indexAsk,
    healthyCount,
    healthyVenues: healthy.map((h) => h.tick.venue),
    // Carried on the result, not left implicit, because `degraded` is no longer a
    // statement about one global number: with per-market bounds, "healthyCount 2,
    // degraded false" is correct for one feed and a bug for another. Every consumer that
    // reports or re-checks degradation — /status, the API payload, the liquidator's own
    // gate, the UI copy — needs the threshold that produced this verdict, and deriving it
    // again from a global constant is exactly how those layers drift apart.
    minHealthyVenues: bounds.minHealthyVenues,
    rejected,
    degraded,
    noData,
  };
}

/** Order types that open new exposure — blocked in degraded mode. Names match the
 * on-chain IOstiumPriceUpKeep.OrderType enum. */
export const OPEN_ORDER_TYPES = new Set(['MARKET_OPEN', 'LIMIT_OPEN']);

/**
 * The do-not-sign gate. "If venues disagree beyond bounds: do not sign" (error table,
 * design spec §7) is implemented as: refuse entirely with zero healthy venues (nothing
 * to price with), and refuse opens specifically while degraded (fewer than
 * minHealthyVenues) — closes and collateral removal may still proceed so existing
 * positions are not trapped.
 *
 * @param {string} orderTypeName e.g. 'MARKET_OPEN'
 * @param {IndexResult} aggregate
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function canSignForOrderType(orderTypeName, aggregate) {
  if (aggregate.noData) return { ok: false, reason: 'no_healthy_venues' };
  if (OPEN_ORDER_TYPES.has(orderTypeName) && aggregate.degraded) {
    return { ok: false, reason: 'degraded_opens_blocked' };
  }
  return { ok: true };
}
