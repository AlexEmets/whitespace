import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenEvent, watchLiveness } from '../src/watcher.mjs';
import { createSequencerMonitor, SequencerState } from '../src/sequencerLiveness.mjs';

const TRADER = '0x1111111111111111111111111111111111111111';

test('toOpenEvent extracts (trader, pairIndex, index, blockNumber) from a MarketOpenExecuted-shaped log', () => {
  const log = {
    args: {
      orderId: 5n,
      t: {
        collateral: 999_000000n,
        openPrice: 65001_000000000000000000n,
        tp: 0n,
        sl: 0n,
        trader: TRADER,
        leverage: 1000,
        pairIndex: 0,
        index: 2,
        buy: true,
        isDayTrade: false,
      },
      priceImpactP: 0n,
      tradeNotional: 0n,
    },
    blockNumber: 12345n,
  };

  const event = toOpenEvent(log);

  assert.equal(event.trader, TRADER);
  assert.equal(event.pairIndex, 0);
  assert.equal(event.index, 2);
  assert.equal(event.blockNumber, 12345n);
});

test('toOpenEvent defaults blockNumber to 0n when the log has none (defensive, should not normally happen)', () => {
  const event = toOpenEvent({ args: { t: { trader: TRADER, pairIndex: 1, index: 0 } } });
  assert.equal(event.blockNumber, 0n);
});

const NO_TABLE = { pruneFromBlock() {} };

/** Lets the pending getBlockNumber promise settle and the next setTimeout get armed. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function runPolls(t, n, intervalMs) {
  for (let i = 0; i < n; i++) {
    await flush();
    t.mock.timers.tick(intervalMs);
  }
  await flush();
}

test('watchLiveness: a total RPC outage from startup reaches STALLED', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const monitor = createSequencerMonitor({ stallThresholdMs: 30_000 });
  const publicClient = { getBlockNumber: async () => { throw new Error('ECONNREFUSED'); } };

  const stop = watchLiveness(publicClient, monitor, NO_TABLE, 1_000);
  await runPolls(t, 31, 1_000);
  stop();

  assert.equal(monitor.state, SequencerState.STALLED);
});

test('watchLiveness: an outage after blocks were seen reaches STALLED', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const monitor = createSequencerMonitor({ stallThresholdMs: 30_000 });
  let calls = 0;
  const publicClient = {
    getBlockNumber: async () => {
      calls++;
      if (calls <= 3) return BigInt(100 + calls);
      throw new Error('ECONNREFUSED');
    },
  };

  const stop = watchLiveness(publicClient, monitor, NO_TABLE, 1_000);
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
  const publicClient = { getBlockNumber: async () => block++ };

  const stop = watchLiveness(publicClient, monitor, NO_TABLE, 1_000);
  await runPolls(t, 40, 1_000);
  stop();

  assert.equal(monitor.state, SequencerState.LIVE);
});
