/**
 * Live entrypoint: connects every configured venue over WebSocket for every
 * configured market, samples the mark EMA on a fixed timer, and serves signed reports
 * over HTTP. Not exercised by the unit test suite (per the task's constraints) — run
 * manually with `pnpm --filter @whitespace/price-publisher start`, or `node
 * src/main.mjs` from this directory.
 */

import { loadConfig } from './config.mjs';
import { createPublisherEngine } from './engine.mjs';
import { createServerApp } from './server.mjs';
import { connectVenue } from './venues/index.mjs';
import { getMarket } from '@whitespace/shared/markets';

async function main() {
  const config = loadConfig();
  console.log(`[price-publisher] chainId=${config.chainId} verifier=${config.verifierAddress}`);
  console.log(`[price-publisher] markets=${config.markets.join(',')} venues=${config.venues.join(',')}`);
  console.log(`[price-publisher] signerKeys=${config.signerKeys.length} threshold(k)=${config.signatureThresholdK}`);
  if (config.signerKeys.length < config.signatureThresholdK) {
    console.warn(
      `[price-publisher] WARNING: only ${config.signerKeys.length} signer key(s) configured, ` +
        `below the k=${config.signatureThresholdK} threshold — every sign attempt will be refused ` +
        `with "insufficient_signer_keys" until more are provisioned.`,
    );
  }

  const engine = createPublisherEngine({
    chainId: config.chainId,
    verifierAddress: config.verifierAddress,
    markets: config.markets,
    bounds: config.bounds,
    signerKeys: config.signerKeys,
    signatureThresholdK: config.signatureThresholdK,
  });

  const stopFns = [];
  for (const feed of config.markets) {
    const market = getMarket(feed);
    for (const venueId of config.venues) {
      const symbol = market.venueSymbols[venueId];
      if (!symbol) continue;
      const stop = connectVenue(
        venueId,
        symbol,
        (tick) => engine.ingestTick(feed, tick),
        (err) => console.error(`[price-publisher] ${venueId}/${feed} error:`, err.message),
      );
      stopFns.push(stop);
      console.log(`[price-publisher] connecting ${venueId} for ${feed} (${symbol})`);
    }
  }

  const sampleTimer = setInterval(() => {
    for (const feed of config.markets) {
      const { aggregate, mark } = engine.sampleMark(feed);
      if (aggregate.degraded) {
        console.warn(
          `[price-publisher] ${feed} DEGRADED: healthy=${aggregate.healthyCount} ` +
            `venues=[${aggregate.healthyVenues.join(',')}] mark=${mark}`,
        );
      }
    }
  }, config.bounds.markEmaSampleIntervalMs);

  const server = createServerApp(engine);
  server.listen(config.port, () => {
    console.log(`[price-publisher] HTTP API listening on :${config.port}`);
  });

  const shutdown = () => {
    console.log('[price-publisher] shutting down');
    clearInterval(sampleTimer);
    for (const stop of stopFns) stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[price-publisher] fatal:', err);
  process.exit(1);
});
