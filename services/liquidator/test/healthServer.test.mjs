import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthServerApp } from '../src/healthServer.mjs';
import { createLiquidatorMetrics } from '../src/metrics.mjs';

// Local loopback HTTP only (ephemeral port on 127.0.0.1) -- same pattern as
// services/price-publisher/test/server.test.mjs. No external network.
async function withServer(fn) {
  const metrics = createLiquidatorMetrics();
  const server = createHealthServerApp(metrics);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, metrics);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /health returns 200 { ok: true }', async () => {
  await withServer(async (base) => {
    const res = await fetch(new URL('/health', base));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
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
