/**
 * Minimal HTTP surface for the liquidator — no framework dependency, same node:http
 * style as services/price-publisher/src/server.mjs.
 *
 *   GET /health   -> 200 { ok: true, lastSweepAgeMs }   a sweep completed recently
 *                 -> 503 { ok: false, lastSweepAgeMs }  none within maxSweepAgeMs
 *   GET /metrics  -> 200 text/plain; Prometheus exposition format (packages/metrics)
 *
 * /health used to answer 200 unconditionally, so a bot whose sweep was wedged (a hung
 * RPC, database or publisher call) looked healthy to the supervisor and every monitor
 * while no trigger went out. It now fails once no sweep has completed for maxSweepAgeMs;
 * before the first one, the age counts from startup.
 */

import { createServer } from 'node:http';

/** Sweeps run every couple of seconds; a minute without one completing is wedged. */
export const DEFAULT_MAX_SWEEP_AGE_MS = 60_000;

/**
 * @param {ReturnType<typeof import('./metrics.mjs').createLiquidatorMetrics>} metrics
 * @param {object} [opts]
 * @param {() => number|null} [opts.lastSweepCompletedAt] ms of the last completed sweep
 * @param {number} [opts.maxSweepAgeMs]
 * @param {() => number} [opts.now]
 */
export function createHealthServerApp(metrics, { lastSweepCompletedAt = () => null, maxSweepAgeMs = DEFAULT_MAX_SWEEP_AGE_MS, now = Date.now } = {}) {
  const startedAt = now();
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      const lastSweepAgeMs = now() - (lastSweepCompletedAt() ?? startedAt);
      const ok = lastSweepAgeMs <= maxSweepAgeMs;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok, lastSweepAgeMs }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(metrics.render());
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}
