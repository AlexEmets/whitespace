/**
 * Minimal HTTP surface for the keeper, same node:http style as the liquidator's.
 *
 *   GET /health   -> 200 { ok: true, ... } while the watcher is polling successfully
 *                 -> 503 { ok: false, ... } before the first poll, or once polls stall
 *   GET /metrics  -> 200 text/plain; Prometheus exposition format (packages/metrics)
 */

import { createServer } from 'node:http';

/**
 * @param {{ health: () => { ok: boolean } & Record<string, unknown>, renderMetrics: () => string }} app
 */
export function createHealthServerApp({ health, renderMetrics }) {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      const body = health();
      res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(renderMetrics());
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}
