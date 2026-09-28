/**
 * Live entrypoint: watches OstiumTradingCallbacks for newly opened trades to build a
 * candidate position table, polls the chain for liveness/reorg detection, and on a
 * timer sweeps every candidate through the exact margin engine, submitting a LIQ
 * trigger for anything found below maintenance margin. Not exercised by the unit test
 * suite — run manually with `pnpm --filter @whitespace/liquidator start`, or
 * `node src/main.mjs` from this directory.
 *
 * REQUIRES `tradesUpKeepAddress` to be configured. As of this writing that is NOT
 * possible against live 1874: `OstiumTradesUpKeep` is not deployed and not registered
 * in the registry (see src/config.mjs and docs/decisions/phase-6-liquidator.md). This
 * entrypoint still starts and runs its full detection/metrics loop without it —
 * everything up to "submit a trigger" works and is observable on /metrics — but
 * `submitLiquidation` calls will fail loudly (not silently) until that address exists.
 */

import { loadConfig, loadForwarderKey } from './config.mjs';
import { createClients, createEndpointProbes, endpointLabel } from './rpc.mjs';
import { createChainReader } from './chainReader.mjs';
import { createPositionTable } from './positionTable.mjs';
import { createSequencerMonitor } from './sequencerLiveness.mjs';
import { createLiquidatorEngine } from './liquidatorEngine.mjs';
import { createLiquidatorMetrics } from './metrics.mjs';
import { createHealthServerApp } from './healthServer.mjs';
import { createDeadLetterQueue } from './deadLetter.mjs';
import { createTxSender } from './txSender.mjs';
import { LimitOrder } from './abi.mjs';
import { watchOpenEvents, watchLiveness } from './watcher.mjs';
import { createSweepLoop } from './sweepLoop.mjs';

async function main() {
  const config = loadConfig();
  console.log(`[liquidator] chainId=${config.chainId}`);
  console.log(`[liquidator] tradesUpKeep=${config.tradesUpKeepAddress ?? '(not configured -- see docs/decisions/phase-6-liquidator.md)'}`);
  console.log(`[liquidator] publisher=${config.publisherBaseUrl}`);

  const forwarderKey = loadForwarderKey(config.forwarderKeyPath); // never logged
  const { publicClient, walletClient, account } = createClients({
    rpcUrls: config.rpcUrls,
    forwarderPrivateKey: forwarderKey.privateKey,
  });
  console.log(`[liquidator] forwarder address=${account.address}`);

  const metrics = createLiquidatorMetrics();
  const positionTable = createPositionTable();
  const sequencerMonitor = createSequencerMonitor();
  const deadLetter = createDeadLetterQueue({ filePath: config.deadLetterFilePath });

  const chainReader = createChainReader({
    publicClient,
    tradingStorageAddress: config.tradingStorageAddress,
    pairInfosAddress: config.pairInfosAddress,
    pairsStorageAddress: config.pairsStorageAddress,
    publisherBaseUrl: config.publisherBaseUrl,
  });

  const txSender = config.tradesUpKeepAddress
    ? createTxSender({
        publicClient,
        walletClient,
        account,
        tradesUpKeepAddress: config.tradesUpKeepAddress,
        deadLetter,
        maxRetries: config.maxRetries,
      })
    : null;

  const engine = createLiquidatorEngine({
    readTrade: chainReader.readTrade,
    readMaxLeverage: chainReader.readMaxLeverage,
    readLiqMarginThresholdP: chainReader.readLiqMarginThresholdP,
    readIndexPrice: chainReader.readIndexPrice,
    readVenueHealth: chainReader.readVenueHealth,
    sequencerMonitor,
    submitLiquidation: async (candidate) => {
      if (!txSender) {
        return { ok: false, reason: 'tradesUpKeep_not_configured' };
      }
      return txSender.sendPerformUpkeep({
        trades: [{ ...candidate, limitOrder: LimitOrder.LIQ }],
        timestamp: Math.floor(Date.now() / 1000),
      });
    },
    metrics,
  });

  const healthServer = createHealthServerApp(metrics);
  healthServer.listen(config.metricsPort, () => {
    console.log(`[liquidator] health/metrics on :${config.metricsPort}`);
  });

  const stopWatchingOpens = watchOpenEvents(
    publicClient,
    config.callbacksAddress,
    (event) => {
      console.log(`[liquidator] candidate discovered trader=${event.trader} pairIndex=${event.pairIndex} index=${event.index}`);
      positionTable.upsertFromOpen(event);
    },
    (err) => console.error('[liquidator] watcher error:', err.message),
  );

  const stopWatchingLiveness = watchLiveness({
    endpoints: createEndpointProbes(config.rpcUrls),
    sequencerMonitor,
    intervalMs: config.pollingIntervalMs,
    onEndpointResult: (url, ok) => metrics.setRpcHealth(endpointLabel(url), ok),
    onReorg: (blockNumber) => positionTable.pruneFromBlock(blockNumber),
  });

  const sweepLoop = createSweepLoop({
    intervalMs: config.pollingIntervalMs,
    sweep: async () => {
      metrics.setSequencerState(sequencerMonitor.state);
      metrics.deadLetterDepth.set(deadLetter.size());
      const results = await engine.evaluateAll(positionTable.list());
      const submitted = results.filter((r) => r.action === 'submitted');
      if (submitted.length > 0) {
        console.log(`[liquidator] submitted ${submitted.length} liquidation trigger(s)`);
      }
    },
    onError: (err) => console.error('[liquidator] sweep error:', err.message),
  });
  sweepLoop.start();

  const shutdown = () => {
    console.log('[liquidator] shutting down');
    sweepLoop.stop();
    stopWatchingOpens();
    stopWatchingLiveness();
    healthServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[liquidator] fatal:', err);
  process.exit(1);
});
