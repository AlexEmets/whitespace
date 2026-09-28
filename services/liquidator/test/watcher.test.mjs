import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchLiveness } from '../src/watcher.mjs';
import { createSequencerMonitor, SequencerState } from '../src/sequencerLiveness.mjs';
import { createLiquidatorMetrics } from '../src/metrics.mjs';

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
