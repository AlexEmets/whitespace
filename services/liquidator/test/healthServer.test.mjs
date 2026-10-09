import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthServerApp } from '../src/healthServer.mjs';
import { createLiquidatorMetrics } from '../src/metrics.mjs';

// Local loopback HTTP only (ephemeral port on 127.0.0.1) -- same pattern as
// services/price-publisher/test/server.test.mjs. No external network.
async function withServer(fn, opts) {
  const metrics = createLiquidatorMetrics();
  const server = createHealthServerApp(metrics, opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, metrics);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /health returns 200 while sweeps keep completing, 503 once the last is older than the bound', async () => {
  const clock = { t: 1_000_000 };
  let last = null;
  const opts = { lastSweepCompletedAt: () => last, maxSweepAgeMs: 60_000, now: () => clock.t };
  await withServer(async (base) => {
    const health = async () => {
      const res = await fetch(new URL('/health', base));
      return [res.status, await res.json()];
    };
    // Before the first sweep the age counts from startup.
    assert.deepEqual(await health(), [200, { ok: true, lastSweepAgeMs: 0 }]);
    clock.t += 60_001;
    assert.deepEqual(await health(), [503, { ok: false, lastSweepAgeMs: 60_001 }], 'no sweep ever completed');

    last = clock.t;
    clock.t += 60_000;
    assert.deepEqual(await health(), [200, { ok: true, lastSweepAgeMs: 60_000 }], 'exactly at the bound is still fine');
    clock.t += 1;
    assert.deepEqual(await health(), [503, { ok: false, lastSweepAgeMs: 60_001 }], 'the sweep is wedged');
    last = clock.t;
    assert.deepEqual(await health(), [200, { ok: true, lastSweepAgeMs: 0 }], 'recovers with the next sweep');
  }, opts);
});

test('GET /metrics returns Prometheus text exposition including a known counter', async () => {
  await withServer(async (base, metrics) => {
    metrics.triggersAttempted.inc(2, { kind: 'LIQ' });
    const res = await fetch(new URL('/metrics', base));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    assert.match(text, /liquidator_triggers_attempted_total\{kind="LIQ"\} 2/);
  });
});

test('unknown routes return 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(new URL('/nope', base));
    assert.equal(res.status, 404);
  });
});
