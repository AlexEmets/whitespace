/**
 * Live entrypoint: watches PriceRequestedV2 on the price upkeep, fetches a signed
 * report from the price-publisher HTTP API, and submits performUpkeep as the
 * registered forwarder. Not exercised by the unit test suite — run manually with
 * `pnpm --filter @whitespace/keeper start`, or `node src/main.mjs` from this
 * directory. See docs/decisions/phase-3-price-publisher.md for whether this was
 * actually run against live testnet 1874.
 */

import { loadConfig, loadForwarderKey } from './config.mjs';
import { createClients } from './rpc.mjs';
import { watchPriceRequested } from './watcher.mjs';
import { createHttpReportSource } from './reportSource.mjs';
import { createTxSender } from './txSender.mjs';
import { createDeadLetterQueue } from './deadLetter.mjs';
import { createKeeperEngine } from './keeperEngine.mjs';

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

  const deadLetter = createDeadLetterQueue({ filePath: config.deadLetterFilePath });
  const reportSource = createHttpReportSource(config.publisherBaseUrl);
  const txSender = createTxSender({
    publicClient,
    walletClient,
    account,
    priceUpKeepAddress: config.priceUpKeepAddress,
    deadLetter,
    maxRetries: config.maxRetries,
  });
  const engine = createKeeperEngine({
    reportSource,
    txSender,
    onDeadLetter: (entry) => console.error('[keeper] DEAD LETTER:', entry),
  });

  const unwatch = watchPriceRequested(
    publicClient,
    config.priceUpKeepAddress,
    async (event) => {
      console.log(
        `[keeper] PriceRequestedV2 orderId=${event.orderId} type=${event.orderTypeName} ` +
          `feed=${event.feed} timestamp=${event.timestamp}`,
      );
      const result = await engine.handlePriceRequested(event);
      if (result.ok) {
        console.log(`[keeper] orderId=${event.orderId} delivered, tx=${result.hash}`);
      } else {
        console.error(`[keeper] orderId=${event.orderId} FAILED: ${result.reason}`);
      }
    },
    (err) => console.error('[keeper] watcher error:', err.message),
  );

  const shutdown = () => {
    console.log('[keeper] shutting down');
    unwatch();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[keeper] fatal:', err);
  process.exit(1);
});
