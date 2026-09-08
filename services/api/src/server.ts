import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Router } from './router.js';
import { handleHealth } from './routes/health.js';
import { handleMarkets, handleMarket, handleCandles } from './routes/markets.js';
import { handlePositions, handlePositionsHistory } from './routes/positions.js';
import { handleOrders } from './routes/orders.js';
import { handlePrice } from './routes/price.js';
import { createWsManager, type WsManager } from './ws.js';

const router = new Router();
router.get('/health', handleHealth);
router.get('/markets', handleMarkets);
router.get('/markets/:pairIndex', handleMarket);
router.get('/markets/:pairIndex/candles', handleCandles);
router.get('/positions/:address', handlePositions);
router.get('/positions/:address/history', handlePositionsHistory);
router.get('/orders/:address', handleOrders);
router.get('/price/:pairIndex', handlePrice);

export type App = { server: Server; wsManager: WsManager };

export function createApp(opts: { wsPollIntervalMs?: number } = {}): App {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const matched = router.match(req.method ?? 'GET', url.pathname);
        if (!matched) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const { code, body } = await matched.handler(req, matched.params, url.searchParams);
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
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
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`services/api listening on :${port}`);
  });
}
