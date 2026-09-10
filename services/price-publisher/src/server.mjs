/**
 * Minimal HTTP API for the publisher — no framework dependency, just node:http.
 *
 *   GET  /health                                     -> 200 { ok: true, feeds: {...} } when at
 *                                                        least one feed has a live venue
 *                                                     -> 503 { ok: false, ... } when none does,
 *                                                        i.e. nothing can be signed
 *   GET  /status                                     -> 200 { feeds: { <feed>: snapshot } }
 *   GET  /v2/report?feed=&timestamp=&orderType=       -> 200 { signedReport, signers, mark, ... }
 *                                                     -> 409 { error: reason } when the
 *                                                        do-not-sign gate refuses (degraded
 *                                                        opens, no data, no mark yet, etc.)
 *
 * `timestamp` is passed straight through to the engine, verbatim — the caller (the
 * keeper) is responsible for supplying the exact value from the order's
 * PriceRequestedV2 log. This server never substitutes Date.now() for it.
 */

import { createServer } from 'node:http';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/**
 * @param {ReturnType<typeof import('./engine.mjs').createPublisherEngine>} engine
 */
export function createServerApp(engine) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Health is about whether this service can do its job, and its job is producing a
    // signable price. A publisher with no venue connected cannot; the keeper then has no
    // report to deliver and NOTHING can be traded.
    //
    // This used to answer a hardcoded `{ ok: true }`. That is how a nine-hour total
    // outage went unnoticed on this stack: every venue socket was half-open, `/status`
    // showed `healthyCount: 0`, and `/health` — the only thing the supervisor and any
    // monitor look at — kept cheerfully reporting success. A health check that cannot
    // fail is not a health check.
    //
    // 503, not a 200 with a flag, so that anything speaking plain HTTP (a load balancer,
    // a probe, the stack's own readiness gate) gets the answer without having to know
    // this service's payload shape.
    if (req.method === 'GET' && url.pathname === '/health') {
      const feeds = {};
      let feedsWithVenues = 0;
      for (const feed of engine.markets) {
        const aggregate = engine.currentAggregate(feed);
        feeds[feed] = {
          healthyCount: aggregate.healthyCount,
          healthyVenues: aggregate.healthyVenues,
          degraded: aggregate.degraded,
          noData: aggregate.noData,
        };
        if (aggregate.healthyCount > 0) feedsWithVenues++;
      }
      // `degraded` (fewer healthy venues than the k-threshold) is still 200: the publisher
      // is working and the aggregate says so honestly, and the do-not-sign gate downstream
      // is what decides whether that is good enough to trade on. Only "no venue at all on
      // any feed" is a failed health check.
      const ok = engine.markets.length > 0 && feedsWithVenues > 0;
      return sendJson(res, ok ? 200 : 503, { ok, feedsWithVenues, totalFeeds: engine.markets.length, feeds });
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const feeds = {};
      for (const feed of engine.markets) {
        const snap = engine.snapshot(feed);
        const aggregate = engine.currentAggregate(feed);
        feeds[feed] = {
          mark: snap.mark,
          healthyCount: aggregate.healthyCount,
          healthyVenues: aggregate.healthyVenues,
          degraded: aggregate.degraded,
          noData: aggregate.noData,
          index: aggregate.index,
          // The aggregated bid and ask behind the index. Already computed by
          // `computeIndex` and already signed into every v2 report (see
          // `engine.signReportFor`), but previously never exposed — so the read API had no
          // spread to serve, and the terminal's price-impact ladder could not compute the
          // spread component of a fill price at all. Null when the aggregate has no
          // two-sided quote; consumers must not substitute the mark for a missing side.
          indexBid: aggregate.indexBid ?? null,
          indexAsk: aggregate.indexAsk ?? null,
        };
      }
      return sendJson(res, 200, { feeds });
    }

    if (req.method === 'GET' && url.pathname === '/v2/report') {
      const feed = url.searchParams.get('feed');
      const timestampParam = url.searchParams.get('timestamp');
      const orderType = url.searchParams.get('orderType');
      if (!feed || !timestampParam || !orderType) {
        return sendJson(res, 400, { error: 'feed, timestamp and orderType are required' });
      }
      if (!engine.markets.includes(feed)) {
        return sendJson(res, 404, { error: `unknown feed "${feed}"` });
      }
      const timestamp = Number(timestampParam);
      if (!Number.isInteger(timestamp) || timestamp < 0) {
        return sendJson(res, 400, { error: 'timestamp must be a non-negative integer (uint32 seconds)' });
      }
      const result = await engine.signReportFor(feed, timestamp, orderType);
      if (!result.ok) {
        return sendJson(res, 409, { error: result.reason });
      }
      return sendJson(res, 200, {
        signedReport: result.signedReport,
        signers: result.signers,
        mark: result.mark,
        healthyVenues: result.aggregate.healthyVenues,
      });
    }

    sendJson(res, 404, { error: 'not found' });
  });
}
