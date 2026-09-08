/**
 * Minimal HTTP surface for the liquidator — no framework dependency, same node:http
 * style as services/price-publisher/src/server.mjs.
 *
 *   GET /health   -> 200 { ok: true }
 *   GET /metrics  -> 200 text/plain; Prometheus exposition format (packages/metrics)
 */

import { createServer } from 'node:http';

/**
 * @param {ReturnType<typeof import('./metrics.mjs').createLiquidatorMetrics>} metrics
 */
export function createHealthServerApp(metrics) {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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
