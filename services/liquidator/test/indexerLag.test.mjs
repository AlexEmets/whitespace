import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIndexerLagCheck } from '../src/indexerLag.mjs';
import { createLiquidatorMetrics } from '../src/metrics.mjs';

function setup({ status, head, nowMs = 2_000_000_000_000 }) {
  const ref = { status, head };
  const metrics = createLiquidatorMetrics();
  const warnings = [];
  const infos = [];
  const check = createIndexerLagCheck({
    readSyncStatus: async () => ref.status,
    latestHead: () => ref.head,
    metrics,
    warn: (m) => warnings.push(m),
    info: (m) => infos.push(m),
    maxLagSec: 30,
    now: () => nowMs,
  });
  return { ref, metrics, warnings, infos, check: check.check };
}

test('lag is published in blocks and seconds, measured on the chain head', async () => {
  const { metrics, warnings, check } = setup({
    status: { blockNumber: 990n, blockTimestamp: 1_000 },
    head: { number: 1_000n, timestamp: 1_010n },
  });
  assert.deepEqual(await check(), { lagBlocks: 10, lagSeconds: 10, lagging: false });
  assert.equal(metrics.indexerLagBlocks.value(), 10);
  assert.equal(metrics.indexerLagSeconds.value(), 10);
  assert.deepEqual(warnings, []);
});

test('past the bound it warns once, and says so when it has caught up', async () => {
  const { ref, warnings, infos, check } = setup({
    status: { blockNumber: 1_000n, blockTimestamp: 1_000 },
    head: { number: 1_030n, timestamp: 1_030n },
  });
  assert.equal((await check()).lagging, false, 'exactly at the bound is not lagging');
  ref.head = { number: 1_031n, timestamp: 1_031n };
  assert.equal((await check()).lagging, true);
  await check();
  assert.equal(warnings.length, 1, 'not once per sweep');
  assert.match(warnings[0], /31s \/ 31 blocks behind/);

  ref.status = { blockNumber: 1_031n, blockTimestamp: 1_031 };
  assert.equal((await check()).lagging, false);
  assert.deepEqual(infos, ['indexer caught up (0s behind)']);
});

test('without a known head the wall clock stands in, and blocks are not published', async () => {
  const { metrics, check } = setup({ status: { blockNumber: 5n, blockTimestamp: 1_999_999_900 }, head: null });
  assert.deepEqual(await check(), { lagBlocks: null, lagSeconds: 100, lagging: true });
  assert.equal(metrics.indexerLagSeconds.value(), 100);
});

test('an indexer ahead of our head (a lagging RPC) is zero lag, not negative', async () => {
  const { check } = setup({ status: { blockNumber: 1_005n, blockTimestamp: 1_005 }, head: { number: 1_000n, timestamp: 1_000n } });
  assert.deepEqual(await check(), { lagBlocks: 0, lagSeconds: 0, lagging: false });
});

test('no sync_status row: warned once, nothing published', async () => {
  const { ref, warnings, metrics, check } = setup({ status: null, head: { number: 1n, timestamp: 1n } });
  assert.equal(await check(), null);
  assert.equal(await check(), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no sync_status/);
  assert.equal(metrics.indexerLagSeconds.value(), 0);
  ref.status = { blockNumber: 1n, blockTimestamp: 1 };
  assert.equal((await check()).lagSeconds, 0);
});
