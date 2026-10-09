import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationEngine, triggerKey } from '../src/automationEngine.mjs';
import { createLiquidatorMetrics } from '../src/metrics.mjs';
import { LimitOrder } from '../src/abi.mjs';

const E18 = 10n ** 18n;
const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const STATIC = { priceImpactK: 0n, netVolThreshold: 0n, decayRate: 0n, buyVolume: 0n, sellVolume: 0n, lastUpdateTimestamp: 0n };
const NOW_MS = 1_800_000_000_000;

// 1000 USDW long at 100, 10x, 100x max, 25% threshold: liquidation boundary 90.25.
const TRADE = {
  tradeId: 1n,
  collateral: 1_000_000000n,
  leverage: 1000n,
  openPrice: 100n * E18,
  tp: 0n,
  sl: 0n,
  buy: true,
  isDayTrade: false,
  initialLeverage: 1000n,
  createdAt: 1_000,
  tpLastUpdated: 1_000,
  slLastUpdated: 1_000,
  rolloverFee: 0n,
  fundingFee: 0n,
};
const LIQ_PRICE = 90_249999000000000000n;
const SAFE_PRICE = 100n * E18;

const ORDER = {
  orderType: 'LIMIT',
  buy: true,
  isDayTrade: false,
  targetPrice: 99n * E18,
  tp: 0n,
  sl: 0n,
  collateral: 1_000_000000n,
  leverage: 1000n,
  lastUpdated: 1_000,
};

const pos = (trader, index, pairIndex = 0) => ({ trader, pairIndex, index });

/**
 * A fully in-memory world. `trades` / `orders` are the chain, keyed `${trader}-${pair}-${index}`;
 * `positions` / `limitOrders` are what the indexer returns.
 */
function world(overrides = {}) {
  const w = {
    positions: [],
    limitOrders: [],
    trades: {},
    orders: {},
    price: SAFE_PRICE,
    bid: null,
    ask: null,
    healthy: 4,
    minHealthy: 3,
    sequencerState: 'LIVE',
    pending: new Set(),
    now: NOW_MS,
    sendResults: [],
    sends: [],
    calls: { readTrade: 0, readLimitOrder: 0, readMaxLeverage: [], snapshot: 0 },
    ...overrides,
  };
  const metrics = createLiquidatorMetrics();
  const deps = {
    listCandidates: async () => ({ positions: w.positions, limitOrders: w.limitOrders, limitOrdersAvailable: true }),
    readPriceSnapshot: async () => {
      w.calls.snapshot++;
      if (w.snapshotError) throw new Error(w.snapshotError);
      return {
        quoteFor: async () => ({
          price: w.price,
          bid: w.bid ?? w.price,
          ask: w.ask ?? w.price,
          healthyVenueCount: w.healthy,
          minHealthyVenues: w.minHealthy,
          ...(w.untradeable ? { untradeable: w.untradeable } : {}),
        }),
      };
    },
    readTrade: async (trader, pairIndex, index) => {
      w.calls.readTrade++;
      const k = `${trader}-${pairIndex}-${index}`;
      if (w.throwFor === k) throw new Error('execution reverted');
      return w.trades[k] ?? null;
    },
    readLimitOrder: async (trader, pairIndex, index) => {
      w.calls.readLimitOrder++;
      return w.orders[`${trader}-${pairIndex}-${index}`] ?? null;
    },
    readOpenFees: async () => ({ takerFeeP: 0n, oracleFee: 0n, builder: '0x0000000000000000000000000000000000000000', builderFee: 0n }),
    readImpact: async () => STATIC,
    readMaxLeverage: async (pairIndex, isDayTrade) => {
      w.calls.readMaxLeverage.push([pairIndex, isDayTrade]);
      return 10000n;
    },
    readLiqMarginThresholdP: async () => 25n,
    readTriggerPending: async (trader, pairIndex, index, limitOrder) => w.pending.has(`${trader}-${pairIndex}-${index}-${limitOrder}`),
    sequencerMonitor: {
      get state() {
        return w.sequencerState;
      },
    },
    sendPerformUpkeep: async (payload) => {
      w.sends.push(payload);
      const r = w.sendResults.shift() ?? { ok: true, hash: '0xh' };
      if (r instanceof Error) throw r;
      return r;
    },
    now: () => w.now,
    metrics,
    ...(overrides.deps ?? {}),
  };
  return { w, metrics, engine: createAutomationEngine(deps), deps };
}

const sentTrades = (w) => w.sends.flatMap((s) => s.trades);
const sentKinds = (w) => sentTrades(w).map((t) => [t.trader, t.index, t.limitOrder]);

// ---------------------------------------------------------------- liquidation

test('a liquidatable position is sent as LIQ, with the timestamp in seconds and a delivery deadline', async () => {
  const { w, engine, metrics } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };

  const { sent } = await engine.sweep();

  assert.equal(w.sends.length, 1);
  assert.deepEqual(w.sends[0], {
    trades: [{ trader: A, pairIndex: 0, index: 0, limitOrder: LimitOrder.LIQ }],
    timestamp: NOW_MS / 1000,
    // maxAge 10 s minus the keeper's 4 s margin
    deadlineMs: NOW_MS + 6_000,
  });
  assert.equal(sent[0].ok, true);
  assert.equal(metrics.positionsBelowMaintenance.value(), 1);
  assert.equal(metrics.triggersSent.value({ kind: 'LIQ' }), 1);
});

test('exactly at the maintenance boundary nothing is sent (strict <, like the contract)', async () => {
  const { w, engine, metrics } = world({ price: 90_250000000000000000n });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.equal(results[0].reason, 'not_hit');
  assert.equal(metrics.positionsBelowMaintenance.value(), 0);
});

for (const isDayTrade of [true, false]) {
  test(`max leverage is resolved with the trade's own isDayTrade (${isDayTrade})`, async () => {
    const { w, engine } = world();
    w.positions = [pos(A, 0)];
    w.trades[`${A}-0-0`] = { ...TRADE, isDayTrade };
    await engine.sweep();
    assert.deepEqual(w.calls.readMaxLeverage, [[0, isDayTrade]]);
  });
}

// ---------------------------------------------------------------- TP / SL

test('SL hit on a long is sent as SL; TP hit is sent as TP', async () => {
  const { w, engine } = world({ price: 95n * E18 });
  w.positions = [pos(A, 0), pos(B, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 95n * E18 };
  w.trades[`${B}-0-0`] = { ...TRADE, openPrice: 90n * E18, tp: 95n * E18 };
  await engine.sweep();
  assert.deepEqual(sentKinds(w), [
    [A, 0, LimitOrder.SL],
    [B, 0, LimitOrder.TP],
  ]);
});

test('the chain decides, not the indexer: a DB row whose SL was removed on chain is not triggered', async () => {
  const { w, engine } = world({ price: 95n * E18 });
  w.positions = [{ ...pos(A, 0), sl: 99n * E18 }];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 0n };
  await engine.sweep();
  assert.equal(w.sends.length, 0);
});

test('LIQ supersedes SL and TP on the same position: exactly one trigger, LIQ', async () => {
  const { w, engine } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 95n * E18 };
  await engine.sweep();
  assert.deepEqual(sentKinds(w), [[A, 0, LimitOrder.LIQ]]);
});

test('SL / TP respect executeAutomationOrder timestamps (NO_SL / NO_TP / BACKDATED would be wasted)', async () => {
  const nowSec = NOW_MS / 1000;
  const { w, engine } = world({ price: 95n * E18 });
  w.positions = [pos(A, 0), pos(A, 1), pos(A, 2)];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 95n * E18, slLastUpdated: nowSec + 1 };
  w.trades[`${A}-0-1`] = { ...TRADE, openPrice: 90n * E18, tp: 95n * E18, tpLastUpdated: nowSec + 1 };
  w.trades[`${A}-0-2`] = { ...TRADE, sl: 95n * E18, createdAt: nowSec + 1 };
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.deepEqual(results.map((r) => r.reason), ['backdated', 'backdated', 'backdated']);
});

test('the boundary second itself is not backdated (priceTimestamp == lastUpdated is allowed)', async () => {
  const nowSec = NOW_MS / 1000;
  const { w, engine } = world({ price: 95n * E18 });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 95n * E18, slLastUpdated: nowSec, createdAt: nowSec };
  await engine.sweep();
  assert.equal(w.sends.length, 1);
});

// ---------------------------------------------------------------- gates

test('degraded market: LIQ held back by default, and SL on the same liquidatable trade is held back too', async () => {
  const { w, engine, metrics } = world({ price: LIQ_PRICE, healthy: 2 });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 95n * E18 };
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.equal(results[0].reason, 'degraded_liquidations_suppressed');
  assert.equal(metrics.suppressedDegraded.value({ kind: 'LIQ' }), 1);
});

test('degraded market with liquidateWhenDegraded: LIQ goes out', async () => {
  const { w, engine } = world({ price: LIQ_PRICE, healthy: 2, deps: { liquidateWhenDegraded: true } });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  await engine.sweep();
  assert.deepEqual(sentKinds(w), [[A, 0, LimitOrder.LIQ]]);
});

test('degraded market: an SL on a trade that is NOT liquidatable still fires (closes flow)', async () => {
  const { w, engine } = world({ price: 95n * E18, healthy: 2 });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 95n * E18 };
  await engine.sweep();
  assert.deepEqual(sentKinds(w), [[A, 0, LimitOrder.SL]]);
});

test('a market with its own minimum of 2 venues is not degraded at 2', async () => {
  const { w, engine } = world({ price: LIQ_PRICE, healthy: 2, minHealthy: 2 });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  await engine.sweep();
  assert.equal(w.sends.length, 1);
});

test('sequencer RECOVERING: LIQ held back (and SL on it), a plain SL and a limit entry still fire', async () => {
  const { w, engine, metrics } = world({ price: LIQ_PRICE, sequencerState: 'RECOVERING' });
  w.positions = [pos(A, 0), pos(B, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 95n * E18 }; // liquidatable
  w.trades[`${B}-0-0`] = { ...TRADE, openPrice: 80n * E18, sl: 91n * E18 }; // SL hit, not liquidatable
  w.limitOrders = [pos(A, 1)];
  w.orders[`${A}-0-1`] = { ...ORDER };
  await engine.sweep();
  assert.deepEqual(sentKinds(w), [
    [B, 0, LimitOrder.SL],
    [A, 1, LimitOrder.OPEN],
  ]);
  assert.equal(metrics.suppressedSequencer.value({ kind: 'LIQ' }), 1);
});

test('sequencer STALLED: nothing is sent at all', async () => {
  const { w, engine } = world({ price: LIQ_PRICE, sequencerState: 'STALLED' });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 95n * E18 };
  w.limitOrders = [pos(A, 1)];
  w.orders[`${A}-0-1`] = { ...ORDER };
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.ok(results.every((r) => r.reason === 'sequencer_stalled'));
});

test('a quote with a zero side is MARKET_CLOSED on chain: nothing is sent', async () => {
  const { w, engine } = world({ price: LIQ_PRICE, bid: 0n });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  w.limitOrders = [pos(A, 1)];
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.deepEqual(results.map((r) => r.reason), ['market_closed', 'market_closed']);
  assert.equal(w.calls.readLimitOrder, 0);
});

test('a stale mark or no venue data: nothing is triggered, with the publisher\'s reason', async () => {
  for (const [flag, reason] of [
    ['mark_stale', 'mark_stale'],
    ['no_data', 'no_data'],
  ]) {
    const { w, engine } = world({ price: LIQ_PRICE });
    w.positions = [pos(A, 0)];
    w.trades[`${A}-0-0`] = { ...TRADE };
    w.limitOrders = [pos(A, 1)];
    w.orders[`${A}-0-1`] = { ...ORDER };
    w.untradeable = flag;
    const { results } = await engine.sweep();
    assert.equal(w.sends.length, 0);
    assert.deepEqual(results.map((r) => r.reason), [reason, reason]);
    assert.equal(w.calls.readLimitOrder, 0);
  }
});

// ---------------------------------------------------------------- limit / stop entries

test('a LIMIT buy whose ask reached the target is sent as OPEN', async () => {
  const { w, engine } = world({ price: 98n * E18, ask: 99n * E18, bid: 97n * E18 });
  w.limitOrders = [pos(A, 3)];
  w.orders[`${A}-0-3`] = { ...ORDER };
  await engine.sweep();
  assert.deepEqual(sentKinds(w), [[A, 3, LimitOrder.OPEN]]);
});

test('a LIMIT buy not yet reached is not sent', async () => {
  const { w, engine } = world({ price: 98n * E18, ask: 99n * E18 + 1n, bid: 97n * E18 });
  w.limitOrders = [pos(A, 3)];
  w.orders[`${A}-0-3`] = { ...ORDER };
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.equal(results[0].reason, 'not_hit');
});

test('limit entries are never triggered in a degraded market, and cost no chain reads there', async () => {
  const { w, engine, metrics } = world({ price: 90n * E18, healthy: 2 });
  w.limitOrders = [pos(A, 3)];
  w.orders[`${A}-0-3`] = { ...ORDER };
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.equal(results[0].reason, 'degraded_opens_blocked');
  assert.equal(w.calls.readLimitOrder, 0);
  assert.equal(metrics.suppressedDegraded.value({ kind: 'OPEN' }), 1);
});

test('a limit entry updated after the sweep timestamp is skipped (BACKDATED_EXECUTION)', async () => {
  const { w, engine } = world({ price: 90n * E18 });
  w.limitOrders = [pos(A, 3)];
  w.orders[`${A}-0-3`] = { ...ORDER, lastUpdated: NOW_MS / 1000 + 1 };
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.equal(results[0].reason, 'backdated');
});

test('a limit entry already filled/cancelled on chain is a lost race, not a send', async () => {
  const { w, engine, metrics } = world({ price: 90n * E18 });
  w.limitOrders = [pos(A, 3)];
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.equal(results[0].reason, 'not_open');
  assert.equal(metrics.lostRace.value({ kind: 'OPEN' }), 1);
});

// ---------------------------------------------------------------- races, errors

test('a position already closed on chain is skipped as a lost race', async () => {
  const { w, engine, metrics } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0)];
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.equal(results[0].reason, 'not_open');
  assert.equal(metrics.lostRace.value({ kind: 'close' }), 1);
});

test('a trigger already pending on chain (another instance, or ours) is not re-sent', async () => {
  const { w, engine } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  w.pending.add(`${A}-0-0-${LimitOrder.LIQ}`);
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 0);
  assert.equal(results[0].reason, 'pending_trigger');
});

test('one candidate whose read throws does not stop the others', async () => {
  const { w, engine, metrics } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0), pos(A, 1), pos(A, 2)];
  for (const i of [0, 1, 2]) w.trades[`${A}-0-${i}`] = { ...TRADE };
  w.throwFor = `${A}-0-1`;
  const { results } = await engine.sweep();
  assert.deepEqual(sentKinds(w), [
    [A, 0, LimitOrder.LIQ],
    [A, 2, LimitOrder.LIQ],
  ]);
  assert.equal(results.find((r) => r.action === 'error').reason, 'execution reverted');
  assert.equal(metrics.candidateErrors.value(), 1);
});

test('no price snapshot: nothing is evaluated or sent, and the staleness gauge keeps growing', async () => {
  const { w, engine, metrics } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  await engine.sweep(); // a good snapshot at NOW_MS
  assert.equal(metrics.oracleStalenessMs.value(), 0);
  w.snapshotError = 'publisher /status returned 503';
  w.now += 5_000;
  const r = await engine.sweep();
  assert.match(r.error, /503/);
  assert.equal(metrics.oracleStalenessMs.value(), 5_000);
  assert.equal(metrics.sweepErrors.value({ stage: 'prices' }), 1);
  assert.equal(w.sends.length, 1, 'only the first sweep sent');
});

test('staleness before any successful snapshot counts from engine start', async () => {
  const { w, engine, metrics } = world({ snapshotError: 'down' });
  w.now += 7_000;
  await engine.sweep();
  assert.equal(metrics.oracleStalenessMs.value(), 7_000);
});

test('an indexer failure fails the sweep instead of acting on a partial view', async () => {
  const { engine } = world({ deps: { listCandidates: async () => Promise.reject(new Error('ECONNREFUSED 5432')) } });
  await assert.rejects(engine.sweep(), /5432/);
});

test('a sendPerformUpkeep that throws is recorded as a failure, not thrown', async () => {
  const { w, engine, metrics } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  w.sendResults = [new Error('nonce too low')];
  const { sent } = await engine.sweep();
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].reason, 'nonce too low');
  assert.equal(metrics.triggersFailed.value({ kind: 'LIQ' }), 1);
});

// ---------------------------------------------------------------- batching, dedupe, cooldown

test('triggers are batched into performUpkeep calls of at most maxBatchSize', async () => {
  const { w, engine, metrics } = world({ price: LIQ_PRICE, deps: { maxBatchSize: 2 } });
  for (let i = 0; i < 5; i++) {
    w.positions.push(pos(A, i));
    w.trades[`${A}-0-${i}`] = { ...TRADE };
  }
  await engine.sweep();
  assert.deepEqual(w.sends.map((s) => s.trades.length), [2, 2, 1]);
  assert.deepEqual(sentTrades(w).map((t) => t.index), [0, 1, 2, 3, 4]);
  assert.equal(metrics.batchesSent.value({ ok: 'true' }), 3);
});

test('the same slot listed twice by the indexer is sent once', async () => {
  const { w, engine } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0), { ...pos(A.toUpperCase().replace('0X', '0x'), 0) }];
  w.trades[`${A}-0-0`] = { ...TRADE };
  w.trades[`${A.toUpperCase().replace('0X', '0x')}-0-0`] = { ...TRADE };
  await engine.sweep();
  assert.equal(sentTrades(w).length, 1);
});

test('cooldown: a sent trigger is not re-sent until cooldownMs has passed', async () => {
  const { w, engine } = world({ price: LIQ_PRICE, deps: { cooldownMs: 30_000 } });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };

  await engine.sweep();
  assert.equal(w.sends.length, 1);
  assert.equal(engine.isCoolingDown(triggerKey(A, 0, 0, 'LIQ')), true);

  w.now += 29_999;
  const { results } = await engine.sweep();
  assert.equal(w.sends.length, 1, 'still cooling down');
  assert.equal(results[0].reason, 'cooldown');

  w.now += 1;
  await engine.sweep();
  assert.equal(w.sends.length, 2, 'retried once the cooldown elapsed (e.g. the first came back NOT_HIT)');
});

test('cooldown is per kind: an SL cooling down does not block a LIQ on the same slot', async () => {
  const { w, engine } = world({ price: 95n * E18 });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE, sl: 95n * E18 };
  await engine.sweep();
  assert.deepEqual(sentKinds(w), [[A, 0, LimitOrder.SL]]);
  w.price = LIQ_PRICE;
  w.now += 1_000;
  await engine.sweep();
  assert.deepEqual(sentKinds(w), [
    [A, 0, LimitOrder.SL],
    [A, 0, LimitOrder.LIQ],
  ]);
});

test('a limit entry cooling down costs no chain reads', async () => {
  const { w, engine } = world({ price: 90n * E18 });
  w.limitOrders = [pos(A, 3)];
  w.orders[`${A}-0-3`] = { ...ORDER };
  await engine.sweep();
  assert.equal(w.calls.readLimitOrder, 1);
  w.now += 1_000;
  const { results } = await engine.sweep();
  assert.equal(results[0].reason, 'cooldown');
  assert.equal(w.calls.readLimitOrder, 1);
  assert.equal(w.sends.length, 1);
});

test('a failed send also cools down (no hammering a reverting trigger every sweep)', async () => {
  const { w, engine } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  w.sendResults = [{ ok: false, reason: 'reverted' }];
  await engine.sweep();
  w.now += 1_000;
  await engine.sweep();
  assert.equal(w.sends.length, 1);
});

test('a failed multi-trigger batch is retried one trigger per transaction; success clears that', async () => {
  const { w, engine } = world({ price: LIQ_PRICE, deps: { cooldownMs: 10 } });
  w.positions = [pos(A, 0), pos(B, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  w.trades[`${B}-0-0`] = { ...TRADE };
  w.sendResults = [{ ok: false, reason: 'reverted' }];

  await engine.sweep();
  assert.deepEqual(w.sends.map((s) => s.trades.length), [2]);
  assert.equal(engine.isIsolated(triggerKey(A, 0, 0, 'LIQ')), true);

  w.now += 10;
  w.sendResults = [{ ok: false, reason: 'reverted' }, { ok: true }];
  await engine.sweep();
  assert.deepEqual(w.sends.map((s) => s.trades.length), [2, 1, 1], 'isolated: one per tx');
  assert.equal(engine.isIsolated(triggerKey(A, 0, 0, 'LIQ')), true, 'a single failure keeps it isolated');
  assert.equal(engine.isIsolated(triggerKey(B, 0, 0, 'LIQ')), false, 'success clears isolation');
});

test('rejects a batch size below 1', () => {
  assert.throws(() => world({ deps: { maxBatchSize: 0 } }), /maxBatchSize/);
});

// ---------------------------------------------------------------- trigger freshness

/** A world whose trade reads take `readMs` of (fake) time each and whose sends log the clock. */
function slowWorld(readMs, deps = {}) {
  const ref = {};
  const built = world({
    price: LIQ_PRICE,
    deps: {
      readTrade: async (trader, pairIndex, index) => {
        ref.w.now += readMs;
        return ref.w.trades[`${trader}-${pairIndex}-${index}`] ?? null;
      },
      sendPerformUpkeep: async (payload) => {
        ref.w.sends.push({ ...payload, at: ref.w.now });
        return ref.w.sendResults.shift() ?? { ok: true, hash: '0xh' };
      },
      ...deps,
    },
  });
  ref.w = built.w;
  return built;
}

test('the timestamp is taken when the batch is sent, not when the sweep started', async () => {
  // Three 5 s reads one after another: a 15 s sweep, so a sweep-start timestamp would be
  // past the 10 s maxAge before it was even sent.
  const { w, engine } = slowWorld(5_000, { evaluationConcurrency: 1 });
  for (let i = 0; i < 3; i++) {
    w.positions.push(pos(A, i));
    w.trades[`${A}-0-${i}`] = { ...TRADE };
  }
  const { sent } = await engine.sweep();
  assert.equal(w.sends.length, 1);
  assert.equal(w.sends[0].at, NOW_MS + 15_000);
  assert.equal(w.sends[0].timestamp, (NOW_MS + 15_000) / 1000);
  assert.equal(w.sends[0].deadlineMs, NOW_MS + 15_000 + 6_000);
  assert.equal(sent[0].timestamp, (NOW_MS + 15_000) / 1000);
});

test('a sub-second clock is floored to the second for both timestamp and deadline', async () => {
  const { w, engine } = slowWorld(1_999, { evaluationConcurrency: 1 });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  await engine.sweep();
  assert.equal(w.sends[0].timestamp, NOW_MS / 1000 + 1);
  assert.equal(w.sends[0].deadlineMs, NOW_MS + 1_000 + 6_000);
});

test('maxAge and the keeper margin are configurable and set the deadline', async () => {
  const { w, engine } = world({ price: LIQ_PRICE, deps: { reportMaxAgeSec: 20, deliveryMarginSec: 5 } });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  await engine.sweep();
  assert.equal(w.sends[0].deadlineMs, NOW_MS + 15_000);
});

test('a margin that leaves less than one second to send in is rejected', () => {
  assert.throws(() => world({ deps: { reportMaxAgeSec: 10, deliveryMarginSec: 10 } }), /deliveryMarginSec/);
  assert.throws(() => world({ deps: { reportMaxAgeSec: 10, deliveryMarginSec: 9.5 } }), /deliveryMarginSec/);
  assert.throws(() => world({ deps: { deliveryMarginSec: -1 } }), /deliveryMarginSec/);
  assert.doesNotThrow(() => world({ deps: { reportMaxAgeSec: 10, deliveryMarginSec: 9 } }));
});

test('candidates are evaluated concurrently, never more than evaluationConcurrency at once, results in candidate order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const ref = {};
  const { w, engine } = world({
    price: LIQ_PRICE,
    deps: {
      evaluationConcurrency: 4,
      readTrade: async (trader, pairIndex, index) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Earlier candidates finish later, so completion order is the reverse of input order.
        await new Promise((r) => setTimeout(r, 20 - index));
        inFlight--;
        return ref.w.trades[`${trader}-${pairIndex}-${index}`] ?? null;
      },
    },
  });
  ref.w = w;
  for (let i = 0; i < 10; i++) {
    w.positions.push(pos(A, i));
    w.trades[`${A}-0-${i}`] = { ...TRADE };
  }
  const { results } = await engine.sweep();
  assert.equal(maxInFlight, 4);
  assert.deepEqual(results.map((r) => r.candidate.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(sentTrades(w).map((t) => t.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('rejects an evaluation concurrency below 1', () => {
  assert.throws(() => world({ deps: { evaluationConcurrency: 0 } }), /evaluationConcurrency/);
});

test('batches are handed to the sender together, not one receipt after another', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { w, engine } = world({
    price: LIQ_PRICE,
    deps: {
      maxBatchSize: 1,
      sendPerformUpkeep: async (payload) => {
        w.sends.push(payload);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { ok: true, hash: '0xh' };
      },
    },
  });
  for (let i = 0; i < 3; i++) {
    w.positions.push(pos(A, i));
    w.trades[`${A}-0-${i}`] = { ...TRADE };
  }
  const { sent } = await engine.sweep();
  assert.equal(maxInFlight, 3);
  assert.deepEqual(sent.map((s) => s.keys[0]), [0, 1, 2].map((i) => triggerKey(A, 0, i, 'LIQ')));
});

test('a trigger that expired before it was broadcast is not cooled down: the next sweep re-sends it', async () => {
  const { w, engine, metrics } = world({ price: LIQ_PRICE });
  w.positions = [pos(A, 0)];
  w.trades[`${A}-0-0`] = { ...TRADE };
  w.sendResults = [{ ok: false, expired: true, attempts: 0, reason: 'deadline_passed before attempt 1' }];
  const { sent } = await engine.sweep();
  assert.equal(sent[0].expired, true);
  assert.equal(engine.isCoolingDown(triggerKey(A, 0, 0, 'LIQ')), false);
  assert.equal(metrics.triggersExpired.value({ kind: 'LIQ' }), 1);
  assert.equal(metrics.triggersFailed.value({ kind: 'LIQ' }), 0);

  w.now += 1_000;
  await engine.sweep();
  assert.equal(w.sends.length, 2);
  assert.equal(w.sends[1].timestamp, NOW_MS / 1000 + 1, 'with a fresh timestamp');

  // Expired AFTER an attempt: that transaction may still mine, so this one does cool down.
  w.sendResults = [{ ok: false, expired: true, attempts: 1, reason: 'deadline_passed before attempt 2 (last: receipt_timeout)' }];
  w.now += 30_000;
  await engine.sweep();
  assert.equal(w.sends.length, 3);
  assert.equal(engine.isCoolingDown(triggerKey(A, 0, 0, 'LIQ')), true);
  w.now += 1_000;
  await engine.sweep();
  assert.equal(w.sends.length, 3);
});

test('position and limit-order counts are published', async () => {
  const { w, engine, metrics } = world();
  w.positions = [pos(A, 0), pos(A, 1)];
  w.limitOrders = [pos(B, 0)];
  await engine.sweep();
  assert.equal(metrics.positionsTracked.value(), 2);
  assert.equal(metrics.limitOrdersTracked.value(), 1);
  assert.equal(metrics.limitOrderTableAvailable.value(), 1);
});
