import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown } from '../src/lifecycle.mjs';
import { createSweepLoop } from '../src/sweepLoop.mjs';

test('shutdown stops scheduling, waits for the in-flight sweep, then closes resources in that order', async () => {
  const order = [];
  let release;
  const loop = createSweepLoop({ intervalMs: 1_000, sweep: () => new Promise((r) => (release = r)).then(() => order.push('sweep done')) });
  loop.start();
  const shutdown = createShutdown({
    loop,
    stoppers: [() => order.push('watchers stopped')],
    closers: [async () => order.push('pool closed')],
  });

  const done = shutdown();
  await Promise.resolve();
  assert.deepEqual(order, ['watchers stopped'], 'must not close the pool under a running sweep');
  release();
  const r = await done;
  assert.deepEqual(order, ['watchers stopped', 'sweep done', 'pool closed']);
  assert.equal(r.timedOut, false);
});

test('shutdown gives up waiting after graceMs and still closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closed = [];
  const loop = createSweepLoop({ intervalMs: 1_000, sweep: () => new Promise(() => {}) }); // never settles
  loop.start();
  const shutdown = createShutdown({ loop, closers: [async () => closed.push('x')], graceMs: 5_000 });
  const done = shutdown();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(5_000);
  const r = await done;
  assert.equal(r.timedOut, true);
  assert.deepEqual(closed, ['x']);
});

test('a second signal returns the same shutdown, closers run once, and a failing closer does not block the rest', async () => {
  let closes = 0;
  const loop = createSweepLoop({ intervalMs: 1_000, sweep: async () => {} });
  const shutdown = createShutdown({
    loop,
    closers: [async () => Promise.reject(new Error('already closed')), async () => closes++],
  });
  const a = shutdown();
  const b = shutdown();
  assert.equal(a, b);
  await a;
  assert.equal(closes, 1);
});
