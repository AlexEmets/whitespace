import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenEvent, watchLiveness } from '../src/watcher.mjs';
import { createSequencerMonitor, SequencerState } from '../src/sequencerLiveness.mjs';
import { createLiquidatorMetrics } from '../src/metrics.mjs';

const TRADER = '0x1111111111111111111111111111111111111111';

test('toOpenEvent extracts (trader, pairIndex, index, blockNumber) from a MarketOpenExecuted-shaped log', () => {
  const log = {
    args: {
      orderId: 5n,
      t: {
        collateral: 999_000000n,
        openPrice: 65001_000000000000000000n,
        tp: 0n,
        sl: 0n,
        trader: TRADER,
        leverage: 1000,
        pairIndex: 0,
        index: 2,
        buy: true,
        isDayTrade: false,
      },
      priceImpactP: 0n,
      tradeNotional: 0n,
    },
    blockNumber: 12345n,
  };

  const event = toOpenEvent(log);

  assert.equal(event.trader, TRADER);
  assert.equal(event.pairIndex, 0);
  assert.equal(event.index, 2);
  assert.equal(event.blockNumber, 12345n);
});

test('toOpenEvent defaults blockNumber to 0n when the log has none (defensive, should not normally happen)', () => {
  const event = toOpenEvent({ args: { t: { trader: TRADER, pairIndex: 1, index: 0 } } });
  assert.equal(event.blockNumber, 0n);
});

/** Lets the pending getBlockNumber promises settle and the next setTimeout get armed. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function runPolls(t, n, intervalMs) {
  for (let i = 0; i < n; i++) {
    await flush();
    t.mock.timers.tick(intervalMs);
  }
  await flush();
}

const down = (url = 'a') => ({
  url,
  getBlockNumber: async () => {
    throw new Error('ECONNREFUSED');
  },
});

test('watchLiveness: a total RPC outage from startup reaches STALLED', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const monitor = createSequencerMonitor({ stallThresholdMs: 30_000 });

  const stop = watchLiveness({ endpoints: [down()], sequencerMonitor: monitor, intervalMs: 1_000 });
  await runPolls(t, 31, 1_000);
  stop();

  assert.equal(monitor.state, SequencerState.STALLED);
});

test('watchLiveness: an outage after blocks were seen reaches STALLED', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const monitor = createSequencerMonitor({ stallThresholdMs: 30_000 });
  let calls = 0;
  const endpoints = [
    {
      url: 'a',
      getBlockNumber: async () => {
        calls++;
        if (calls <= 3) return BigInt(100 + calls);
        throw new Error('ECONNREFUSED');
      },
    },
  ];

  const stop = watchLiveness({ endpoints, sequencerMonitor: monitor, intervalMs: 1_000 });
  await runPolls(t, 3, 1_000);
  assert.equal(monitor.state, SequencerState.LIVE);
  await runPolls(t, 31, 1_000);
  stop();

  assert.equal(monitor.state, SequencerState.STALLED);
});

test('watchLiveness: steadily advancing blocks stay LIVE', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const monitor = createSequencerMonitor({ stallThresholdMs: 30_000 });
  let block = 100n;

  const stop = watchLiveness({
    endpoints: [{ url: 'a', getBlockNumber: async () => block++ }],
    sequencerMonitor: monitor,
    intervalMs: 1_000,
  });
  await runPolls(t, 40, 1_000);
  stop();

  assert.equal(monitor.state, SequencerState.LIVE);
});

test("watchLiveness reports each endpoint's health separately into liquidator_rpc_healthy", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const monitor = createSequencerMonitor({ stallThresholdMs: 30_000 });
  const metrics = createLiquidatorMetrics();
  let block = 100n;
  const endpoints = [{ url: 'https://up.example', getBlockNumber: async () => block++ }, down('https://down.example')];

  const stop = watchLiveness({
    endpoints,
    sequencerMonitor: monitor,
    intervalMs: 1_000,
    onEndpointResult: (url, ok) => metrics.setRpcHealth(url, ok),
  });
  await runPolls(t, 40, 1_000);
  stop();

  const text = metrics.render();
  assert.match(text, /liquidator_rpc_healthy\{endpoint="https:\/\/up\.example"\} 1/);
  assert.match(text, /liquidator_rpc_healthy\{endpoint="https:\/\/down\.example"\} 0/);
  assert.equal(monitor.state, SequencerState.LIVE, 'one healthy endpoint is enough for liveness');
});

test('watchLiveness uses the highest head across endpoints and flags a head that moved backward', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const heads = [
    [10n, 12n],
    [9n, 8n],
  ];
  let tickNo = 0;
  const endpoints = [0, 1].map((i) => ({ url: String(i), getBlockNumber: async () => heads[tickNo][i] }));
  const reorgs = [];
  const observed = [];
  const spy = { observe: (s) => observed.push(s.blockNumber), observeFailure: () => {} };

  const stop = watchLiveness({ endpoints, sequencerMonitor: spy, intervalMs: 1_000, onReorg: (b) => reorgs.push(b) });
  await flush();
  tickNo = 1;
  t.mock.timers.tick(1_000);
  await flush();
  stop();

  assert.deepEqual(observed, [12n, 9n]);
  assert.deepEqual(reorgs, [9n]);
});

test('watchLiveness refuses an empty endpoint list', () => {
  assert.throws(() => watchLiveness({ endpoints: [], sequencerMonitor: {} }), /endpoint/);
});
