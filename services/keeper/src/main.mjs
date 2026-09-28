/**
 * Live entrypoint: builds real viem clients, starts the keeper (src/app.mjs) and its
 * /health + /metrics server. Not exercised by the unit test suite — run manually with
 * `pnpm --filter @whitespace/keeper start`, or `node src/main.mjs` from this directory.
 */

import { loadConfig, loadForwarderKey } from './config.mjs';
import { createClients } from './rpc.mjs';
import { createKeeper } from './app.mjs';
import { createHealthServerApp } from './healthServer.mjs';

async function main() {
  const config = loadConfig();
  console.log(`[keeper] chainId=${config.chainId} priceUpKeep=${config.priceUpKeepAddress}`);
  console.log(`[keeper] rpcUrls=${config.rpcUrls.join(',')}`);
  console.log(`[keeper] publisher=${config.publisherBaseUrl}`);

  const forwarderKey = loadForwarderKey(config.forwarderKeyPath); // never logged
  const { publicClient, walletClient, account } = createClients({
    rpcUrls: config.rpcUrls,
    forwarderPrivateKey: forwarderKey.privateKey,
  });
  console.log(`[keeper] forwarder address=${account.address}`);

  const keeper = createKeeper({ config, publicClient, walletClient, account });
  keeper.start();

  const server = createHealthServerApp(keeper);
  server.listen(config.metricsPort, config.metricsHost, () => {
    console.log(`[keeper] health/metrics on ${config.metricsHost}:${config.metricsPort}`);
  });

  const shutdown = () => {
    console.log('[keeper] shutting down');
    keeper.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[keeper] fatal:', err);
  process.exit(1);
});
