/**
 * The real price publisher — same engine, same venues, same signer keys, same HTTP API —
 * with ONE test-only knob: every venue tick of a chosen feed can be multiplied by
 * (1 + bps/10_000) before it reaches the engine. Nothing else differs from
 * services/price-publisher/src/main.mjs.
 *
 * WHY. The acceptance run on a local anvil (tools/stack/acceptance.mjs) must show a
 * liquidation fired by the automation bots on their own. At max leverage that needs a
 * ~0.75% adverse move, which a real market may not make for hours. Shifting one feed lets
 * the run move the price the whole pipeline sees (publisher → keeper reports → bot mark)
 * while every other feed stays real.
 *
 * NEVER run this against a real chain: it signs prices that are not the market with the
 * oracle signer keys. It refuses to start unless SHIFT_ALLOW=anvil, and it only reads
 * shifts from a file you point it at.
 *
 *   SHIFT_ALLOW=anvil SHIFT_FILE=/tmp/shift.json <the publisher's usual env> \
 *     node tools/stack/shifted-publisher.mjs
 *   echo '{"SOL/USD": -150}' > /tmp/shift.json    # SOL 1.5% lower, applied on the next tick
 *   echo '{}' > /tmp/shift.json                   # back to the real market
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

if (process.env.SHIFT_ALLOW !== 'anvil') {
  console.error('shifted-publisher: refusing to start without SHIFT_ALLOW=anvil (it signs non-market prices)');
  process.exit(2);
}
const SHIFT_FILE = process.env.SHIFT_FILE;
if (!SHIFT_FILE) {
  console.error('shifted-publisher: SHIFT_FILE is required');
  process.exit(2);
}

const publisherSrc = new URL('../../services/price-publisher/src/', import.meta.url);
const load = (rel) => import(new URL(rel, publisherSrc).href);
// @whitespace/shared is a dependency of the publisher, not of the repo root.
const requireFromPublisher = createRequire(new URL('../package.json', publisherSrc));
const loadShared = (sub) => import(pathToFileURL(requireFromPublisher.resolve(`@whitespace/shared/${sub}`)).href);

const { loadConfig } = await load('config.mjs');
const { createPublisherEngine } = await load('engine.mjs');
const { createServerApp } = await load('server.mjs');
const { connectVenue } = await load('venues/index.mjs');
const { getMarket } = await loadShared('markets');

/** Re-read on every tick: a few hundred small reads a second is nothing for a test rig. */
function currentShiftBps(feed) {
  try {
    const bps = JSON.parse(readFileSync(SHIFT_FILE, 'utf8'))[feed];
    return Number.isInteger(bps) ? BigInt(bps) : 0n;
  } catch {
    return 0n;
  }
}

function shiftTick(tick, bps) {
  if (bps === 0n) return tick;
  const scale = (v) => (v * (10_000n + bps)) / 10_000n;
  return { ...tick, bid: scale(tick.bid), ask: scale(tick.ask) };
}

const config = loadConfig();
console.log(`[shifted-publisher] chainId=${config.chainId} verifier=${config.verifierAddress} shiftFile=${SHIFT_FILE}`);
const engine = createPublisherEngine({
  chainId: config.chainId,
  verifierAddress: config.verifierAddress,
  markets: config.markets,
  bounds: config.bounds,
  boundsFor: config.boundsFor,
  signerKeys: config.signerKeys,
  signatureThresholdK: config.signatureThresholdK,
});

const stops = [];
for (const feed of config.markets) {
  const market = getMarket(feed);
  for (const venueId of config.venues) {
    const symbol = market.venueSymbols[venueId];
    if (!symbol) continue;
    stops.push(
      connectVenue(
        venueId,
        symbol,
        (tick) => engine.ingestTick(feed, shiftTick(tick, currentShiftBps(feed))),
        (err) => console.error(`[shifted-publisher] ${venueId}/${feed} error:`, err.message),
      ),
    );
  }
}

const timer = setInterval(() => {
  for (const feed of config.markets) engine.sampleMark(feed);
}, config.bounds.markEmaSampleIntervalMs);

const server = createServerApp(engine, { maxReportAgeS: config.maxReportAgeS, maxClockSkewS: config.maxClockSkewS });
server.listen(config.port, config.host, () => console.log(`[shifted-publisher] listening on ${config.host}:${config.port}`));

const shutdown = () => {
  clearInterval(timer);
  for (const stop of stops) stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
