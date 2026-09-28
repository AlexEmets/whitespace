/**
 * Publisher metrics on the shared @whitespace/metrics registry, served at GET /metrics.
 *
 * Per-feed gauges are read from the engine at scrape time (so they are never stale by
 * more than one scrape); counters are bumped by the /v2/report handler.
 */

import { createRegistry } from '@whitespace/metrics';
import { ORDER_TYPE_NAMES } from '@whitespace/shared/orderTypes';

/** orderType comes from the query string; never let a caller mint label values. */
const labelOrderType = (orderType) => (ORDER_TYPE_NAMES.includes(orderType) ? orderType : 'other');

/**
 * @param {ReturnType<typeof import('./engine.mjs').createPublisherEngine>} engine
 */
export function createPublisherMetrics(engine) {
  const registry = createRegistry();
  const m = {
    healthyVenues: registry.gauge('publisher_healthy_venues', 'Venues currently passing staleness, spread and deviation checks'),
    minHealthyVenues: registry.gauge('publisher_min_healthy_venues', 'Healthy venues required before opens are signed'),
    degraded: registry.gauge('publisher_degraded', '1 when fewer than the required venues are healthy (opens refused)'),
    markAge: registry.gauge('publisher_mark_age_seconds', 'Seconds since a real index sample last moved the mark (-1 if never)'),
    markStale: registry.gauge('publisher_mark_stale', '1 when the mark is past its staleness bound (every report refused)'),
    signed: registry.counter('publisher_reports_signed_total', 'Reports signed by /v2/report'),
    refused: registry.counter('publisher_reports_refused_total', 'Reports refused by /v2/report, by reason'),
  };

  function refresh() {
    for (const feed of engine.markets) {
      const aggregate = engine.currentAggregate(feed);
      const mark = engine.markStatus(feed);
      m.healthyVenues.set(aggregate.healthyCount, { feed });
      m.minHealthyVenues.set(aggregate.minHealthyVenues, { feed });
      m.degraded.set(aggregate.degraded ? 1 : 0, { feed });
      m.markAge.set(mark.markAgeMs === null ? -1 : mark.markAgeMs / 1000, { feed });
      m.markStale.set(mark.stale ? 1 : 0, { feed });
    }
  }

  return {
    registry,
    ...m,
    /** @param {string} feed @param {string} orderType */
    reportSigned(feed, orderType) {
      m.signed.inc(1, { feed, order_type: labelOrderType(orderType) });
    },
    /** @param {string} feed @param {string} reason */
    reportRefused(feed, reason) {
      m.refused.inc(1, { feed, reason });
    },
    render() {
      refresh();
      return registry.render();
    },
  };
}
