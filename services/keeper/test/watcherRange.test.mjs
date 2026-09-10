/**
 * The blind-keeper regression.
 *
 * Whitechain's public RPC refuses `eth_getLogs` above a 10,000-block span. The watcher was
 * viem's `watchContractEvent`, which keeps its own `fromBlock` and does not advance it when
 * a poll fails — so one refusal made the next request wider, which was refused again. The
 * range grew without bound (observed at 42,001 blocks) and the keeper stopped seeing price
 * requests entirely, forever, with no way to recover short of a restart.
 *
 * That is not a degraded keeper. `openTrade` takes the trader's collateral and emits a
 * request; with no report ever delivered the order stays pending and the collateral stays
 * locked. Reproduced on chain: order #7, 50 USDW taken, no position, no cancellation.
 *
 * These tests drive the watcher against a fake client that behaves like that RPC.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { watchPriceRequested } from '../src/watcher.mjs';

const ADDRESS = '0x6d8fa4DE0DD0aF71F044266aA630B560733efC96';
const LIMIT = 10_000n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stands in for the chain. `head` is mutable so a test can advance it, and every
 * `getLogs` range is recorded. Ranges wider than the node's limit are rejected the way
 * the real node rejects them.
 */
function fakeClient({ head, failFirstN = 0 }) {
  const ranges = [];
  let failures = 0;
  return {
    ranges,
    setHead(v) {
      head = v;
    },
    async getBlockNumber() {
      return head;
    },
    async getLogs({ fromBlock, toBlock }) {
      ranges.push({ fromBlock, toBlock, span: toBlock - fromBlock + 1n });
      if (toBlock - fromBlock + 1n > LIMIT) {
        throw new Error('query exceeds max block range 10000');
      }
      if (failures < failFirstN) {
        failures += 1;
        throw new Error('transient RPC error');
      }
      return [];
    },
  };
}

describe('keeper watcher block ranges', () => {
  it('never asks for more blocks than the node allows, even far behind the head', async () => {
    // 42,001 blocks behind — the exact span the stuck keeper was last seen requesting.
    const client = fakeClient({ head: 7_437_314n });
    const stop = watchPriceRequested(client, ADDRESS, () => {}, () => {}, { pollIntervalMs: 20 });
    await sleep(200);
    stop();

    // First tick starts at the head, so seed a backlog and let it catch up.
    const client2 = fakeClient({ head: 1_000n });
    const stop2 = watchPriceRequested(client2, ADDRESS, () => {}, () => {}, { pollIntervalMs: 20 });
    await sleep(60);
    client2.setHead(1_000n + 42_001n);
    await sleep(300);
    stop2();

    assert.ok(client2.ranges.length > 0, 'expected the watcher to have polled');
    for (const r of client2.ranges) {
      assert.ok(r.span <= LIMIT, `range of ${r.span} blocks exceeds the node limit of ${LIMIT}`);
    }
  });

  it('covers the whole backlog with contiguous windows — no block skipped, none re-read', async () => {
    const client = fakeClient({ head: 1_000n });
    const stop = watchPriceRequested(client, ADDRESS, () => {}, () => {}, { pollIntervalMs: 20 });
    await sleep(60);
    const target = 1_000n + 25_000n;
    client.setHead(target);
    await sleep(400);
    stop();

    assert.ok(client.ranges.length >= 3, `expected several chunks, got ${client.ranges.length}`);
    for (let i = 1; i < client.ranges.length; i += 1) {
      assert.equal(
        client.ranges[i].fromBlock,
        client.ranges[i - 1].toBlock + 1n,
        'windows must be contiguous: a gap loses orders, an overlap replays them',
      );
    }
    assert.equal(client.ranges[client.ranges.length - 1].toBlock, target, 'should have reached the head');
  });

  it('retries the same bounded window after a failure instead of widening it', async () => {
    const client = fakeClient({ head: 1_000n, failFirstN: 3 });
    const stop = watchPriceRequested(client, ADDRESS, () => {}, () => {}, { pollIntervalMs: 20 });
    await sleep(60);
    client.setHead(1_000n + 30_000n);
    await sleep(400);
    stop();

    // The whole point: spans must not grow across retries. Before the fix each failure
    // made the next request strictly wider until every one was refused.
    const spans = client.ranges.map((r) => r.span);
    assert.ok(Math.max(...spans.map(Number)) <= Number(LIMIT), `a span grew past the limit: ${spans.join(', ')}`);
    assert.ok(client.ranges.length > 3, 'expected it to keep polling after the failures');
  });

  it('delivers decoded events to the callback', async () => {
    const client = fakeClient({ head: 500n });
    client.getLogs = async () => [
      {
        args: { orderId: 7n, orderType: 0, feed: '0xfeed', timestamp: 1789033447n },
        blockNumber: 501n,
        transactionHash: '0xabc',
      },
    ];
    const seen = [];
    const stop = watchPriceRequested(client, ADDRESS, (e) => seen.push(e), () => {}, { pollIntervalMs: 20 });
    await sleep(60);
    client.setHead(600n);
    await sleep(150);
    stop();

    assert.ok(seen.length > 0, 'expected at least one decoded event');
    assert.equal(seen[0].orderId, 7n);
    assert.equal(seen[0].timestamp, 1789033447);
  });
});
