import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeeper, HEALTH_STALE_MIN_MS } from '../src/app.mjs';
import { createCursorStore } from '../src/cursorStore.mjs';
import { createHealthServerApp } from '../src/healthServer.mjs';
import { toPriceRequestedEvent } from '../src/watcher.mjs';

const UPKEEP = '0x6d8fa4DE0DD0aF71F044266aA630B560733efC96';
const FEED_BTC = '0x4254432f55534400000000000000000000000000000000000000000000000000';
const TS = 1_757_325_600;
const quiet = { log() {}, warn() {}, error() {} };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config(overrides = {}) {
  return {
    priceUpKeepAddress: UPKEEP,
    publisherBaseUrl: 'http://127.0.0.1:1',
    pollingIntervalMs: 750,
    maxRetries: 0,
    deadLetterFilePath: null,
    cursorPath: null,
    maxLookbackBlocks: 120,
    concurrency: 3,
    receiptTimeoutMs: 5_000,
    maxGasBumps: 1,
    ...overrides,
  };
}

function clients(status = 'success') {
  return {
    account: { address: '0x1234567890123456789012345678901234567890' },
    publicClient: {
      getTransactionCount: async () => 0,
      getGasPrice: async () => 1n,
      getTransactionReceipt: async ({ hash }) => ({ status, transactionHash: hash }),
    },
    walletClient: { sendTransaction: async () => `0x${'ab'.repeat(32)}` },
  };
}

/** A watch() stand-in that records its arguments and exposes a settable state. */
function fakeWatch() {
  const calls = [];
  const unwatches = [];
  let state = { cursor: null, head: null, lastSuccessAt: null };
  const watch = (...args) => {
    calls.push(args);
    const unwatch = () => {
      unwatch.stopped = true;
    };
    unwatch.state = () => state;
    unwatches.push(unwatch);
    return unwatch;
  };
  return { watch, calls, unwatches, setState: (s) => (state = s) };
}

const event = () => toPriceRequestedEvent({ args: { orderId: 9n, orderType: 1, feed: FEED_BTC, timestamp: BigInt(TS) } });

function keeperWith(t, { cfg = {}, reportSource, status, now = () => TS * 1000 } = {}) {
  const w = fakeWatch();
  const keeper = createKeeper({
    config: config(cfg),
    ...clients(status),
    reportSource: reportSource ?? { getSignedReport: async () => ({ ok: true, signedReport: '0xdeadbeef' }) },
    watch: w.watch,
    logger: quiet,
    now,
  });
  t.after(() => keeper.stop());
  return { keeper, w };
}

test('the configured polling interval, lookback and concurrency reach the watcher', (t) => {
  const { keeper, w } = keeperWith(t);
  keeper.start();
  const opts = w.calls[0][4];
  assert.equal(w.calls[0][1], UPKEEP);
  assert.equal(opts.pollIntervalMs, 750);
  assert.equal(opts.maxLookbackBlocks, 120);
  assert.equal(opts.concurrency, 3);
  assert.equal(opts.startBlock, null);
});

test('the persisted cursor is the start block, and every advance is saved back', (t) => {
  const cursorPath = join(tempDir(t), 'cursor.json');
  createCursorStore(cursorPath).save(4_242n);
  const { keeper, w } = keeperWith(t, { cfg: { cursorPath } });
  keeper.start();
  const opts = w.calls[0][4];
  assert.equal(opts.startBlock, 4_242n);
  opts.onCursor(5_000n);
  assert.equal(createCursorStore(cursorPath).load(), 5_000n);
});

test('start() is idempotent', (t) => {
  const { keeper, w } = keeperWith(t);
  keeper.start();
  keeper.start();
  assert.equal(w.calls.length, 1);
});

test('a delivered order counts as delivered', async (t) => {
  const { keeper, w } = keeperWith(t);
  keeper.start();
  await w.calls[0][2](event());
  assert.equal(keeper.metrics.requests.value(), 1);
  assert.equal(keeper.metrics.delivered.value(), 1);
  assert.equal(keeper.metrics.failed.value(), 0);
  assert.match(keeper.renderMetrics(), /keeper_tx_confirmed_total 1/);
});

test('a reverted performUpkeep counts as failed and is dead-lettered', async (t) => {
  const { keeper, w } = keeperWith(t, { status: 'reverted' });
  keeper.start();
  await w.calls[0][2](event());
  assert.equal(keeper.metrics.failed.value(), 1);
  assert.equal(keeper.deadLetter.size(), 1);
  assert.match(keeper.renderMetrics(), /keeper_tx_dead_lettered_total 1/);
});

test('an order with no report before its deadline counts as given up, not failed', async (t) => {
  let clock = TS * 1000;
  const { keeper, w } = keeperWith(t, {
    now: () => (clock += 3_000),
    reportSource: { getSignedReport: async () => ({ ok: false, reason: 'degraded_opens_blocked', status: 409 }) },
  });
  keeper.start();
  await w.calls[0][2](event());
  assert.equal(keeper.metrics.gaveUp.value(), 1);
  assert.equal(keeper.metrics.failed.value(), 0);
  assert.ok(keeper.metrics.reportRetries.value() >= 1);
});

test('watcher errors are counted', (t) => {
  const { keeper, w } = keeperWith(t);
  keeper.start();
  w.calls[0][3](new Error('rpc down'));
  assert.equal(keeper.metrics.handlerErrors.value(), 1);
});

test('health: not ok before the first poll, ok while polling, not ok once polls go stale', (t) => {
  let now = 1_000_000;
  const { keeper, w } = keeperWith(t, { now: () => now });
  assert.equal(keeper.health().ok, false, 'not started');
  keeper.start();
  assert.equal(keeper.health().ok, false, 'no poll yet');

  w.setState({ cursor: 101n, head: 100n, lastSuccessAt: now });
  const h = keeper.health();
  assert.equal(h.ok, true);
  assert.equal(h.cursor, 101n);
  assert.equal(h.lastPollAgeMs, 0);

  now += HEALTH_STALE_MIN_MS; // exactly at the bound: still ok
  assert.equal(keeper.health().ok, true);
  now += 1;
  assert.equal(keeper.health().ok, false);
});

test('the staleness bound grows with a long polling interval', (t) => {
  const { keeper } = keeperWith(t, { cfg: { pollingIntervalMs: 10_000 } });
  assert.equal(keeper.health().staleAfterMs, 100_000);
});

test('renderMetrics exports cursor, head and poll age', (t) => {
  let now = 50_000;
  const { keeper, w } = keeperWith(t, { now: () => now });
  assert.match(keeper.renderMetrics(), /keeper_last_poll_age_seconds -1/);
  keeper.start();
  w.setState({ cursor: 101n, head: 100n, lastSuccessAt: 48_000 });
  const text = keeper.renderMetrics();
  assert.match(text, /keeper_cursor_block 101/);
  assert.match(text, /keeper_head_block 100/);
  assert.match(text, /keeper_last_poll_age_seconds 2/);
});

test('stop() stops the watcher', (t) => {
  const { keeper, w } = keeperWith(t);
  keeper.start();
  keeper.stop();
  assert.equal(w.unwatches[0].stopped, true);
  assert.equal(keeper.health().ok, false);
});

async function withServer(app, fn) {
  const server = createHealthServerApp(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('GET /health is 200 when ok and 503 when not, with bigints serialised', async () => {
  let ok = true;
  await withServer({ health: () => ({ ok, cursor: 5n }), renderMetrics: () => '' }, async (base) => {
    let res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cursor: '5' });
    ok = false;
    res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
  });
});

test('GET /metrics serves the Prometheus text; anything else is 404', async () => {
  await withServer({ health: () => ({ ok: true }), renderMetrics: () => 'keeper_x 1\n' }, async (base) => {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.equal(await res.text(), 'keeper_x 1\n');
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/metrics`, { method: 'POST' })).status, 404);
  });
});
