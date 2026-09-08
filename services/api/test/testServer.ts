import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server.js';
import { resetPool } from '../src/db.js';

export type TestServer = {
  app: App;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
};

export async function startTestServer(opts: { wsPollIntervalMs?: number } = {}): Promise<TestServer> {
  resetPool(); // pick up the current DATABASE_URL (globalSetup sets it once, but be defensive)
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
