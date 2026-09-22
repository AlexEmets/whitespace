import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiquidatorEngine } from '../src/liquidatorEngine.mjs';
import { createSequencerMonitor } from '../src/sequencerLiveness.mjs';
import { createRegistry } from '@whitespace/metrics';
import { MIN_HEALTHY_VENUES } from '@whitespace/shared/bounds';

const TRADER = '0x1111111111111111111111111111111111111111';
const CANDIDATE = { trader: TRADER, pairIndex: 0, index: 0 };

// Same fixture as test/marginEngine.test.mjs's boundary tests: 1000 USDW, 10x, 100x
// pair max leverage, 25% liqMarginThresholdP. Liquidation boundary price is
// 90_250000000000000000n (long).
const OPEN_TRADE = {
  collateral: 1_000_000000n,
  leverage: 1000n,
  openPrice: 100_000000000000000000n,
  buy: true,
  initialLeverage: 1000n,
  rolloverFee: 0n,
  fundingFee: 0n,
};

function liveSequencer() {
  const mon = createSequencerMonitor();
  mon.observe({ nowMs: 0, blockNumber: 1n }); // establishes LIVE state
  return mon;
}

function makeMetrics() {
  const reg = createRegistry();
  return {
    reg,
    positionsTracked: reg.gauge('positions_tracked', 'x'),
    positionsBelowMaintenance: reg.gauge('positions_below_maintenance', 'x'),
    liquidationsAttempted: reg.counter('liquidations_attempted_total', 'x'),
    liquidationsWon: reg.counter('liquidations_won_total', 'x'),
    liquidationsLostRace: reg.counter('liquidations_lost_race_total', 'x'),
    liquidationsSuppressedDegraded: reg.counter('liquidations_suppressed_degraded_total', 'x'),
    liquidationsSuppressedSequencer: reg.counter('liquidations_suppressed_sequencer_total', 'x'),
  };
}

function baseDeps(overrides = {}) {
  return {
    readTrade: async () => ({ ...OPEN_TRADE }),
    readMaxLeverage: async () => 10000n,
    readLiqMarginThresholdP: async () => 25n,
    readIndexPrice: async () => 90_249999000000000000n, // just below the boundary -> liquidatable
    readVenueHealth: async () => ({ healthyVenueCount: 4, minHealthyVenues: MIN_HEALTHY_VENUES }),
    sequencerMonitor: liveSequencer(),
    submitLiquidation: async () => ({ ok: true, hash: '0xabc' }),
    metrics: makeMetrics(),
    ...overrides,
  };
}

test('a liquidatable position is submitted and counted as attempted + won', async () => {
  const submitCalls = [];
  const metrics = makeMetrics();
  const engine = createLiquidatorEngine(
    baseDeps({
      submitLiquidation: async (c) => {
        submitCalls.push(c);
        return { ok: true, hash: '0xabc' };
      },
      metrics,
    }),
  );

  const result = await engine.evaluateOne(CANDIDATE);

  assert.equal(result.action, 'submitted');
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(submitCalls[0], CANDIDATE);
  assert.equal(metrics.liquidationsAttempted.value(), 1);
  assert.equal(metrics.liquidationsWon.value(), 1);
});

test('a position above maintenance margin is never submitted', async () => {
  const submitCalls = [];
  const engine = createLiquidatorEngine(
    baseDeps({
      readIndexPrice: async () => 90_250001000000000000n, // just above the boundary -> safe
      submitLiquidation: async (c) => {
        submitCalls.push(c);
        return { ok: true };
      },
    }),
  );

  const result = await engine.evaluateOne(CANDIDATE);

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'above_maintenance');
  assert.equal(submitCalls.length, 0);
});

test('exactly at the maintenance boundary is NOT submitted (strict less-than, matches the contract)', async () => {
  const submitCalls = [];
  const engine = createLiquidatorEngine(
    baseDeps({
      readIndexPrice: async () => 90_250000000000000000n, // exact boundary
      submitLiquidation: async (c) => {
        submitCalls.push(c);
        return { ok: true };
      },
    }),
  );

  const result = await engine.evaluateOne(CANDIDATE);

  assert.equal(result.action, 'skipped');
  assert.equal(submitCalls.length, 0);
});

test('sequencer not LIVE blocks submission entirely, even for an obviously liquidatable position', async () => {
  const stalled = createSequencerMonitor();
  stalled.observe({ nowMs: 0, blockNumber: 1n });
  stalled.observe({ nowMs: 999_999, blockNumber: 1n }); // gap grows without a new block -> STALLED

  const submitCalls = [];
  const metrics = makeMetrics();
  const engine = createLiquidatorEngine(
    baseDeps({
      sequencerMonitor: stalled,
      submitLiquidation: async (c) => {
        submitCalls.push(c);
        return { ok: true };
      },
      metrics,
    }),
  );

  const result = await engine.evaluateOne(CANDIDATE);

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'sequencer_not_live');
  assert.equal(submitCalls.length, 0);
  assert.equal(metrics.liquidationsSuppressedSequencer.value(), 1);
});

test('degraded mode (fewer healthy venues than the market requires) blocks submission, even for a liquidatable position', async () => {
  const submitCalls = [];
  const metrics = makeMetrics();
  const engine = createLiquidatorEngine(
    baseDeps({
      readVenueHealth: async () => ({ healthyVenueCount: 2, minHealthyVenues: MIN_HEALTHY_VENUES }),
      submitLiquidation: async (c) => {
        submitCalls.push(c);
        return { ok: true };
      },
      metrics,
    }),
  );

  const result = await engine.evaluateOne(CANDIDATE);

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'degraded_liquidations_suppressed');
  assert.equal(submitCalls.length, 0);
  assert.equal(metrics.liquidationsSuppressedDegraded.value(), 1);
});

// The reason the threshold is read from the publisher instead of from this service's own
// MIN_HEALTHY_VENUES. A market listed with a lowered minimum (WBT/USD, fed by WhiteBIT's two
// books) sits at a healthy count that is normal for it and below the global constant. Judged
// against the constant, every liquidation on that market is suppressed forever — positions
// stay open past their maintenance margin with nothing in the logs but a rising
// `liquidations_suppressed_degraded` counter, which reads as "the oracle is unhealthy"
// rather than "the liquidator is misconfigured".
test('a market whose own minimum is 2 is liquidated at 2 healthy venues, not suppressed', async () => {
  const submitCalls = [];
  const metrics = makeMetrics();
  const engine = createLiquidatorEngine(
    baseDeps({
      readVenueHealth: async () => ({ healthyVenueCount: 2, minHealthyVenues: 2 }),
      submitLiquidation: async (c) => {
        submitCalls.push(c);
        return { ok: true, hash: '0xabc' };
      },
      metrics,
    }),
  );

  const result = await engine.evaluateOne(CANDIDATE);

  assert.equal(result.action, 'submitted');
  assert.equal(submitCalls.length, 1);
  assert.equal(metrics.liquidationsSuppressedDegraded.value(), 0);
  // Same count, stricter market: still suppressed. The count alone decides nothing.
  assert.ok(2 < MIN_HEALTHY_VENUES);
});

test('a lost race (position already closed by someone else) is handled cleanly: no submission, no throw, no state corruption', async () => {
  const submitCalls = [];
  const metrics = makeMetrics();
  const engine = createLiquidatorEngine(
    baseDeps({
      // Live re-read shows the slot is empty -- someone else got there first (or it
      // never really opened, e.g. a reorg'd discovery log).
      readTrade: async () => ({ ...OPEN_TRADE, leverage: 0n }),
      submitLiquidation: async (c) => {
        submitCalls.push(c);
        return { ok: true };
      },
      metrics,
    }),
  );

  const result = await engine.evaluateOne(CANDIDATE);

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'not_open');
  assert.equal(submitCalls.length, 0, 'must never submit for a slot that is not open');
  assert.equal(metrics.liquidationsLostRace.value(), 1);
  assert.equal(metrics.liquidationsAttempted.value(), 0);
  assert.equal(metrics.liquidationsWon.value(), 0);
});

test('a submission that fails (e.g. someone else\'s trigger landed first, ours reverts) is recorded, not thrown, and not counted as won', async () => {
  const metrics = makeMetrics();
  const engine = createLiquidatorEngine(
    baseDeps({
      submitLiquidation: async () => ({ ok: false, reason: 'reverted: PENDING_TRIGGER' }),
      metrics,
    }),
  );

  const result = await engine.evaluateOne(CANDIDATE);

  assert.equal(result.action, 'failed');
  assert.equal(result.reason, 'reverted: PENDING_TRIGGER');
  assert.equal(metrics.liquidationsAttempted.value(), 1);
  assert.equal(metrics.liquidationsWon.value(), 0);
  assert.equal(metrics.liquidationsLostRace.value(), 1);
});

test('null trade (never seen open on-chain) is treated the same as leverage=0: skip cleanly', async () => {
  const submitCalls = [];
  const engine = createLiquidatorEngine(
    baseDeps({
      readTrade: async () => null,
      submitLiquidation: async (c) => {
        submitCalls.push(c);
        return { ok: true };
      },
    }),
  );

  const result = await engine.evaluateOne(CANDIDATE);

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'not_open');
  assert.equal(submitCalls.length, 0);
});

test('evaluateAll sweeps every candidate independently and updates position-count metrics', async () => {
  const metrics = makeMetrics();
  let call = 0;
  const engine = createLiquidatorEngine(
    baseDeps({
      readTrade: async () => {
        call++;
        // First candidate liquidatable, second not, third not open.
        if (call === 1) return { ...OPEN_TRADE };
        if (call === 2) return { ...OPEN_TRADE };
        return { ...OPEN_TRADE, leverage: 0n };
      },
      readIndexPrice: async () => 90_249999000000000000n, // liquidatable price throughout
      metrics,
    }),
  );

  const candidates = [
    { trader: TRADER, pairIndex: 0, index: 0 },
    { trader: TRADER, pairIndex: 0, index: 1 },
    { trader: TRADER, pairIndex: 0, index: 2 },
  ];

  const results = await engine.evaluateAll(candidates);

  assert.equal(results.length, 3);
  assert.equal(metrics.positionsTracked.value(), 3);
  // Candidate 2's readIndexPrice is still the liquidatable price, so it also submits;
  // only candidate 3 is skipped as not-open. positionsBelowMaintenance counts
  // submitted/failed outcomes.
  assert.equal(metrics.positionsBelowMaintenance.value(), 2);
});
