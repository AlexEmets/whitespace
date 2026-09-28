/**
 * Resuming from a persisted cursor. The watcher always started at the head, so every
 * order requested while the keeper was down (a deploy, a crash) was never filled.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { watchPriceRequested } from '../src/watcher.mjs';

const ADDRESS = '0x6d8fa4DE0DD0aF71F044266aA630B560733efC96';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeClient({ head }) {
  const ranges = [];
  return {
    ranges,
    setHead(v) {
      head = v;
    },
    async getBlockNumber() {
      return head;
    },
    async getLogs({ fromBlock, toBlock }) {
      ranges.push({ fromBlock, toBlock });
      return [];
    },
  };
}

function start(t, client, opts) {
  const stop = watchPriceRequested(client, ADDRESS, () => {}, opts.onError ?? (() => {}), { pollIntervalMs: 10, ...opts });
  t.after(stop);
  return stop;
}

describe('keeper watcher cursor resume', () => {
  it('resumes at the saved cursor when it is within the lookback', async (t) => {
    const client = fakeClient({ head: 1_000n });
    start(t, client, { startBlock: 950n, maxLookbackBlocks: 100 });
    await sleep(30);
    assert.equal(client.ranges[0].fromBlock, 950n);
    assert.equal(client.ranges.at(-1).toBlock, 1_000n);
  });

  it('a stale cursor is clamped to head - lookback instead of rescanning forever', async (t) => {
    const client = fakeClient({ head: 1_000_000n });
    start(t, client, { startBlock: 5n, maxLookbackBlocks: 100 });
    await sleep(30);
    assert.equal(client.ranges[0].fromBlock, 1_000_000n - 99n, 'scans exactly the last 100 blocks');
  });

  it('the lookback boundary itself is kept (cursor == head - lookback + 1)', async (t) => {
    const client = fakeClient({ head: 1_000n });
    start(t, client, { startBlock: 901n, maxLookbackBlocks: 100 });
    await sleep(30);
    assert.equal(client.ranges[0].fromBlock, 901n);
  });

  it('a cursor ahead of the head (e.g. a reset chain) waits at head + 1', async (t) => {
    const client = fakeClient({ head: 1_000n });
    start(t, client, { startBlock: 5_000n, maxLookbackBlocks: 100 });
    await sleep(30);
    assert.equal(client.ranges.length, 0);
    client.setHead(1_002n);
    await sleep(30);
    assert.equal(client.ranges[0].fromBlock, 1_001n);
  });

  it('without a saved cursor it still starts at the head', async (t) => {
    const client = fakeClient({ head: 1_000n });
    start(t, client, { maxLookbackBlocks: 100 });
    await sleep(30);
    assert.equal(client.ranges.length, 0);
  });

  it('reports every advanced cursor to onCursor, after its window was handled', async (t) => {
    const client = fakeClient({ head: 1_000n });
    const saved = [];
    start(t, client, { startBlock: 980n, maxLookbackBlocks: 100, maxBlockRange: 10, onCursor: (c) => saved.push(c) });
    await sleep(40);
    assert.deepEqual(saved, [990n, 1_000n, 1_001n]);
  });

  it('an onCursor failure goes to onError and does not stop the watcher', async (t) => {
    const client = fakeClient({ head: 1_000n });
    const errors = [];
    start(t, client, {
      startBlock: 990n,
      maxLookbackBlocks: 100,
      onCursor: () => {
        throw new Error('disk full');
      },
      onError: (e) => errors.push(e.message),
    });
    await sleep(30);
    client.setHead(1_010n);
    await sleep(30);
    assert.ok(errors.includes('disk full'));
    assert.equal(client.ranges.at(-1).toBlock, 1_010n);
  });

  it('exposes its state (cursor, head, last successful poll) for the health endpoint', async (t) => {
    const client = fakeClient({ head: 1_000n });
    const stop = start(t, client, { startBlock: 990n, maxLookbackBlocks: 100, now: () => 42 });
    await sleep(30);
    assert.deepEqual(stop.state(), { cursor: 1_001n, head: 1_000n, lastSuccessAt: 42 });
  });
});
