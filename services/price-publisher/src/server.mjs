/**
 * Minimal HTTP API for the publisher — no framework dependency, just node:http.
 *
 *   GET  /health                                     -> 200 { ok: true }
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

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
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
