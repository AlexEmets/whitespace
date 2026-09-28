import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSweepLoop } from '../src/sweepLoop.mjs';

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('runOnce while a sweep is in flight joins it instead of starting a second one', async () => {
  let release;
  let calls = 0;
  const loop = createSweepLoop({
    intervalMs: 1_000,
    sweep: () => {
      calls++;
      return new Promise((r) => (release = r));
    },
  });

  const a = loop.runOnce();
  const b = loop.runOnce();
  assert.equal(calls, 1);
  assert.equal(loop.running, true);
  release('done');
  assert.equal(await a, 'done');
  assert.equal(await b, 'done');
  assert.equal(loop.running, false);

  const c = loop.runOnce();
  assert.equal(calls, 2, 'a new sweep starts once the previous one finished');
  release('again');
  await c;
});

test('a sweep slower than the interval never overlaps with the next one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let inFlight = 0;
  let maxInFlight = 0;
  let started = 0;
  const loop = createSweepLoop({
    intervalMs: 1_000,
    sweep: async () => {
      started++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5_000)); // 5x the interval
      inFlight--;
    },
  });

  loop.start();
  for (let i = 0; i < 30; i++) {
    await flush();
    t.mock.timers.tick(1_000);
  }
  await flush();
  loop.stop();

  assert.equal(maxInFlight, 1);
  // 30 s of wall time at 5 s per sweep + 1 s gap => 5 sweeps started, not 30.
  assert.ok(started >= 4 && started <= 6, `started=${started}`);
});

test('a throwing sweep is reported and the loop keeps going', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  let calls = 0;
  const loop = createSweepLoop({
    intervalMs: 1_000,
    sweep: async () => {
      calls++;
      throw new Error(`boom ${calls}`);
    },
    onError: (err) => errors.push(err.message),
  });

  loop.start();
  for (let i = 0; i < 3; i++) {
    await flush();
    t.mock.timers.tick(1_000);
  }
  await flush();
  loop.stop();

  assert.ok(calls >= 3);
  assert.equal(errors[0], 'boom 1');
  assert.equal(errors.length, calls);
});

test('stop() prevents any further sweep from being scheduled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const loop = createSweepLoop({ intervalMs: 1_000, sweep: async () => void calls++ });

  loop.start();
  await flush();
  assert.equal(calls, 1, 'start() runs the first sweep immediately');
  loop.stop();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1_000);
    await flush();
  }
  assert.equal(calls, 1);
});

test('rejects a non-positive interval', () => {
  assert.throws(() => createSweepLoop({ intervalMs: 0, sweep: async () => {} }), /intervalMs/);
});
