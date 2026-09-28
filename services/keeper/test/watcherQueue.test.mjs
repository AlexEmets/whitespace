/**
 * Event handling is awaited. The watcher used to call the async handler without awaiting
 * it, so every order in a window was handled at once (all racing one nonce), a rejected
 * handler became an unhandled rejection, and the cursor moved past orders that had not
 * been handled yet.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { watchPriceRequested } from '../src/watcher.mjs';

const ADDRESS = '0x6d8fa4DE0DD0aF71F044266aA630B560733efC96';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts a watcher that is always stopped when the test ends, pass or fail. */
function start(t, ...args) {
  const stop = watchPriceRequested(...args);
  t.after(stop);
  return stop;
}

function logAt(block, orderId) {
  return { args: { orderId, orderType: 0, feed: '0xfeed', timestamp: 1_789_033_447n }, blockNumber: block, transactionHash: '0xabc' };
}

/** A chain with `logsPerChunk` orders in every window it is asked for. */
function fakeClient({ head, logsPerChunk = 1 }) {
  const ranges = [];
  let nextId = 1n;
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
      return Array.from({ length: logsPerChunk }, () => logAt(fromBlock, nextId++));
    },
  };
}

describe('keeper watcher event handling', () => {
  it('routes a REJECTED async handler to onError instead of an unhandled rejection', async (t) => {
    const client = fakeClient({ head: 100n });
    const errors = [];
    const stop = start(
      t,
      client,
      ADDRESS,
      async () => {
        throw new Error('handler blew up');
      },
      (err) => errors.push(err.message),
      { pollIntervalMs: 10 },
    );
    await sleep(30);
    client.setHead(105n);
    await sleep(60);
    stop();
    assert.ok(errors.includes('handler blew up'), `onError saw: ${errors.join(', ')}`);
  });

  it('does not read the next window until every order in this one has been handled', async (t) => {
    const client = fakeClient({ head: 100n });
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const handled = [];
    const stop = start(
      t,
      client,
      ADDRESS,
      async (e) => {
        await gate;
        handled.push(e.orderId);
      },
      () => {},
      { pollIntervalMs: 10, maxBlockRange: 10 },
    );
    await sleep(30);
    client.setHead(130n); // three windows of 10
    await sleep(80);
    assert.equal(client.ranges.length, 1, 'the watcher moved on while an order was still in flight');
    assert.equal(handled.length, 0);

    release();
    await sleep(80);
    stop();
    assert.equal(client.ranges.length, 3);
    assert.deepEqual(handled, [1n, 2n, 3n]);
  });

  it('handles at most `concurrency` orders at once', async (t) => {
    const client = fakeClient({ head: 100n, logsPerChunk: 6 });
    let inFlight = 0;
    let peak = 0;
    let done = 0;
    const stop = start(
      t,
      client,
      ADDRESS,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight -= 1;
        done += 1;
      },
      () => {},
      { pollIntervalMs: 10, concurrency: 2 },
    );
    await sleep(30);
    client.setHead(101n);
    await sleep(120);
    stop();
    assert.equal(done, 6);
    assert.equal(peak, 2);
  });

  it('refuses a concurrency below 1', (t) => {
    assert.throws(() => start(t, fakeClient({ head: 1n }), ADDRESS, () => {}, () => {}, { concurrency: 0 }), /concurrency/);
  });
});
