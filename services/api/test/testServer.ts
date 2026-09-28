import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server.js';
import { resetPool } from '../src/db.js';
import { ensureIndexSeriesSchema } from '../src/indexSeries.js';
import { ensureFaucetSchema } from '../src/faucet.js';

export type TestServer = {
  app: App;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
};

export async function startTestServer(opts: { wsPollIntervalMs?: number } = {}): Promise<TestServer> {
  resetPool(); // pick up the current DATABASE_URL (globalSetup sets it once, but be defensive)
  // The index series is this service's own storage (src/indexSeries.ts), created by the
  // real entrypoint at boot. Tests need it for the same reason: the candles route reads
  // it first, and an absent table is a 500, not an empty result. Creating it here rather
  // than seeding rows means the suite exercises the empty-series fallback to the
  // indexer's on-chain candles, which is what a fresh deployment actually does.
  await ensureIndexSeriesSchema();
  // The faucet keeps its cooldown ledger in its own schema, created at boot by the real
  // entrypoint; tests need it present for the same reason the index series is created here.
  await ensureFaucetSchema();
  const app = createApp({ wsPollIntervalMs: opts.wsPollIntervalMs ?? 50 });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        app.wsManager.stop();
        app.server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
