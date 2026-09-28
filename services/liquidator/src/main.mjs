/**
 * Automation bot entrypoint (services/liquidator): liquidations, TP, SL and LIMIT/STOP
 * entries through OstiumTradesUpKeep.performUpkeep. See
 * docs/decisions/phase-6-liquidator.md §11.
 *
 * Process-supervisor friendly: configuration is environment only (so a unit file can use
 * `EnvironmentFile=` or `node --env-file=...`), logs go to stdout/stderr with the instance
 * name as prefix, SIGTERM/SIGINT drain the in-flight sweep and exit 0, and a fatal startup
 * error exits 1 so `Restart=on-failure` applies.
 *
 *   node --env-file=/etc/whitespace/automation-bot-1.env services/liquidator/src/main.mjs
 */

import pg from 'pg';
import { loadConfig, describeConfig, loadForwarderKey } from './config.mjs';
import { createClients, createEndpointProbes, endpointLabel } from './rpc.mjs';
import { createChainReader } from './chainReader.mjs';
import { createCandidateSource, pgQuery } from './candidateSource.mjs';
import { createSequencerMonitor } from './sequencerLiveness.mjs';
import { createAutomationEngine } from './automationEngine.mjs';
import { createLiquidatorMetrics } from './metrics.mjs';
import { createHealthServerApp } from './healthServer.mjs';
import { createDeadLetterQueue } from './deadLetter.mjs';
import { createTxSender } from './txSender.mjs';
import { watchLiveness } from './watcher.mjs';
import { createSweepLoop } from './sweepLoop.mjs';
import { createShutdown } from './lifecycle.mjs';

async function main() {
  const config = loadConfig();
  const tag = `[automation:${config.instanceName}]`;
  const log = (...a) => console.log(tag, ...a);
  const logError = (...a) => console.error(tag, ...a);

  log('config', JSON.stringify(describeConfig(config)));

  const forwarderKey = loadForwarderKey(config.forwarderKeyPath); // never logged
  const { publicClient, walletClient, account } = createClients({
    rpcUrls: config.rpcUrls,
    forwarderPrivateKey: forwarderKey.privateKey,
  });
  log(`forwarder=${account.address}`);

  const metrics = createLiquidatorMetrics();
  const sequencerMonitor = createSequencerMonitor();
  const deadLetter = createDeadLetterQueue({ filePath: config.deadLetterFilePath ?? undefined });
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  pool.on('error', (err) => logError('postgres pool error:', err.message));

  const chainReader = createChainReader({
    publicClient,
    tradingStorageAddress: config.tradingStorageAddress,
    pairInfosAddress: config.pairInfosAddress,
    pairsStorageAddress: config.pairsStorageAddress,
    tradingAddress: config.tradingAddress,
    publisherBaseUrl: config.publisherBaseUrl,
  });
  const candidates = createCandidateSource({ query: pgQuery(pool), schema: config.databaseSchema });

  // The only way this service sends a transaction. packages/txsender replaces the
  // implementation behind this one function at merge; nothing else changes.
  const txSender = createTxSender({
    publicClient,
    walletClient,
    account,
    tradesUpKeepAddress: config.tradesUpKeepAddress,
    deadLetter,
    maxRetries: config.maxRetries,
  });
  const sendPerformUpkeep = (payload) => txSender.sendPerformUpkeep(payload);

  const engine = createAutomationEngine({
    listCandidates: candidates.list,
    readPriceSnapshot: chainReader.readPriceSnapshot,
    readTrade: chainReader.readTrade,
    readLimitOrder: chainReader.readLimitOrder,
    readOpenFees: chainReader.readOpenFees,
    readImpact: chainReader.readImpact,
    readMaxLeverage: chainReader.readMaxLeverage,
    readLiqMarginThresholdP: chainReader.readLiqMarginThresholdP,
    readTriggerPending: chainReader.readTriggerPending,
    sequencerMonitor,
    sendPerformUpkeep,
    maxBatchSize: config.maxBatchSize,
    cooldownMs: config.triggerCooldownMs,
    liquidateWhenDegraded: config.liquidateWhenDegraded,
    metrics,
  });

  const healthServer = createHealthServerApp(metrics);
  healthServer.listen(config.metricsPort, config.metricsHost, () => log(`health/metrics on ${config.metricsHost}:${config.metricsPort}`));

  const stopLiveness = watchLiveness({
    endpoints: createEndpointProbes(config.rpcUrls),
    sequencerMonitor,
    intervalMs: config.pollingIntervalMs,
    onEndpointResult: (url, ok) => metrics.setRpcHealth(endpointLabel(url), ok),
  });

  let warnedNoLimitTable = false;
  const loop = createSweepLoop({
    intervalMs: config.pollingIntervalMs,
    sweep: async () => {
      metrics.setSequencerState(sequencerMonitor.state);
      metrics.deadLetterDepth.set(deadLetter.size());
      const { results, sent, error } = await engine.sweep();
      if (error) logError('sweep:', error);
      if (metrics.limitOrderTableAvailable.value() === 0 && !warnedNoLimitTable) {
        warnedNoLimitTable = true;
        logError('indexer has no limit_order table yet: LIMIT/STOP entries are not automated until it does');
      }
      for (const r of results) {
        if (r.action === 'error') logError(`candidate ${r.candidate.trader}/${r.candidate.pairIndex}/${r.candidate.index}:`, r.reason);
      }
      for (const s of sent) {
        log(`performUpkeep ${s.ok ? 'ok' : 'FAILED'} [${s.keys.join(', ')}]${s.hash ? ` ${s.hash}` : ''}${s.reason ? ` ${s.reason}` : ''}`);
      }
    },
    onError: (err) => logError('sweep failed:', err?.message ?? err),
  });
  loop.start();

  const shutdown = createShutdown({
    loop,
    stoppers: [stopLiveness],
    closers: [() => new Promise((r) => healthServer.close(r)), () => pool.end()],
    log,
  });
  const onSignal = (signal) => {
    log(`${signal}: shutting down`);
    shutdown().then(({ timedOut }) => {
      if (timedOut) logError('in-flight sweep did not finish within the grace period');
      process.exit(0);
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

main().catch((err) => {
  console.error('[automation] fatal:', err?.message ?? err);
  process.exit(1);
});
