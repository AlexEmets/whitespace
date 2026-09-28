import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Router } from './router.js';
import { handleHealth } from './routes/health.js';
import { handleMarkets, handleMarket, handleCandles } from './routes/markets.js';
import { handlePositions, handlePositionsHistory } from './routes/positions.js';
import { handleOrders, handleOrdersHistory } from './routes/orders.js';
import { handlePrice } from './routes/price.js';
import { handleLimitOrders } from './routes/limitOrders.js';
import { createWsManager, type WsManager } from './ws.js';
import { ensureIndexSeriesSchema, startIndexRecorder } from './indexSeries.js';

const router = new Router();
router.get('/health', handleHealth);
router.get('/markets', handleMarkets);
router.get('/markets/:pairIndex', handleMarket);
router.get('/markets/:pairIndex/candles', handleCandles);
router.get('/positions/:address', handlePositions);
router.get('/positions/:address/history', handlePositionsHistory);
router.get('/orders/:address', handleOrders);
router.get('/orders/:address/history', handleOrdersHistory);
router.get('/price/:pairIndex', handlePrice);
router.get('/limit-orders/:address', handleLimitOrders);

export type App = { server: Server; wsManager: WsManager };

/**
 * Origins the browser is allowed to read this API from.
 *
 * Without this the API is unreachable from a browser at all: every `fetch` from the web
 * app is cross-origin (different port), so the response is fetched and then discarded by
 * the browser for want of an `Access-Control-Allow-Origin` header. The failure is
 * invisible server-side — the request logs as a normal 200 — and surfaces only as an
 * empty UI and a console full of CORS errors.
 *
 * An allowlist rather than `*`, and the origin is echoed rather than wildcarded, because
 * this service is meant to grow a public deployment and `*` would have to be walked back
 * the moment anything here stops being world-readable. The defaults cover the local stack
 * on both hostnames a developer might type; anything else is configuration.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3100,http://127.0.0.1:3100')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    // Tells caches that the response body depends on the request's Origin, so a response
    // built for one allowed origin is never replayed to another.
    vary: 'Origin',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  };
}

export function createApp(opts: { wsPollIntervalMs?: number } = {}): App {
  const server = createServer((req, res) => {
    void (async () => {
      const cors = corsHeaders(req.headers.origin);
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          res.end();
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const matched = router.match(req.method ?? 'GET', url.pathname);
        if (!matched) {
          res.writeHead(404, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const { code, body } = await matched.handler(req, matched.params, url.searchParams);
        res.writeHead(code, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      } catch (err) {
        res.writeHead(500, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error', message: (err as Error).message }));
      }
    })();
  });

  const wsManager = createWsManager({ pollIntervalMs: opts.wsPollIntervalMs });
  wsManager.attach(server);

  return { server, wsManager };
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isMain) {
  const port = Number(process.env.PORT ?? 3001);
  const { server } = createApp();

  // Only the long-running process records the index series — never `createApp()`, which
  // the test suite calls many times per run and which must not start background timers
  // or reach for a publisher that is not there.
  await ensureIndexSeriesSchema();
  const recorder = startIndexRecorder();
  const stop = () => {
    recorder.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`services/api listening on :${port} (index recorder sampling ${process.env.PUBLISHER_URL ?? 'http://127.0.0.1:8787'})`);
  });
}
