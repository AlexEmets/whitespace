import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, decodeFunctionData } from 'viem';
import { createDeadLetterStore } from '@whitespace/txsender';
import { createRegistry } from '@whitespace/metrics';
import { createTxSender } from '../src/txSender.mjs';
import { TRADES_UPKEEP_ABI } from '../src/abi.mjs';

const ACCOUNT = { address: '0x1234567890123456789012345678901234567890' };
const TRADES_UPKEEP = '0x9999999999999999999999999999999999999999';
const TRADES = [
  { trader: '0x1111111111111111111111111111111111111111', pairIndex: 0, index: 0, limitOrder: 2 },
  { trader: '0x2222222222222222222222222222222222222222', pairIndex: 1, index: 3, limitOrder: 3 },
];
const TUPLE = [
  { type: 'tuple[]', components: [{ name: 'trader', type: 'address' }, { name: 'pairId', type: 'uint256' }, { name: 'index', type: 'uint256' }, { name: 'limitOrder', type: 'uint8' }] },
  { type: 'uint256' },
];

function clients(t, statuses) {
  let sent = 0;
  const publicClient = {
    getTransactionCount: t.mock.fn(async () => 5),
    getGasPrice: t.mock.fn(async () => 1_000_000_000n),
    waitForTransactionReceipt: t.mock.fn(async () => ({ status: statuses[Math.min(sent - 1, statuses.length - 1)] })),
    getTransactionReceipt: t.mock.fn(async () => ({ status: statuses[Math.min(sent - 1, statuses.length - 1)] })),
  };
  const walletClient = {
    sendTransaction: t.mock.fn(async () => {
      sent += 1;
      return `0xhash${sent}`;
    }),
  };
  return { publicClient, walletClient };
}

test('a batch goes out as one legacy performUpkeep to the trades upkeep', async (t) => {
  const { publicClient, walletClient } = clients(t, ['success']);
  const sender = createTxSender({ publicClient, walletClient, account: ACCOUNT, tradesUpKeepAddress: TRADES_UPKEEP, deadLetter: createDeadLetterStore(), registry: createRegistry() });

  const result = await sender.sendPerformUpkeep({ trades: TRADES, timestamp: 1_757_325_600 });
  assert.deepEqual({ ok: result.ok, hash: result.hash }, { ok: true, hash: '0xhash1' });

  const tx = walletClient.sendTransaction.mock.calls[0].arguments[0];
  assert.equal(tx.to, TRADES_UPKEEP);
  assert.equal(tx.type, 'legacy');
  assert.equal(tx.nonce, 5);
  const { functionName, args } = decodeFunctionData({ abi: TRADES_UPKEEP_ABI, data: tx.data });
  assert.equal(functionName, 'performUpkeep');
  const [trades, timestamp] = decodeAbiParameters(TUPLE, args[0]);
  assert.equal(timestamp, 1_757_325_600n);
  assert.deepEqual(
    trades.map((x) => [x.trader, Number(x.pairId), Number(x.index), x.limitOrder]),
    TRADES.map((x) => [x.trader, x.pairIndex, x.index, x.limitOrder]),
  );
  assert.equal(sender.nonce, 6);
});

test('a mined revert is not retried, advances the nonce, and reports failure', async (t) => {
  const { publicClient, walletClient } = clients(t, ['reverted']);
  const deadLetter = createDeadLetterStore();
  const sender = createTxSender({ publicClient, walletClient, account: ACCOUNT, tradesUpKeepAddress: TRADES_UPKEEP, deadLetter, registry: createRegistry() });

  const result = await sender.sendPerformUpkeep({ trades: TRADES, timestamp: 1 });
  assert.equal(result.ok, false);
  assert.equal(walletClient.sendTransaction.mock.callCount(), 1, 'a deterministic revert is not re-sent');
  assert.equal(sender.nonce, 6, 'the reverted tx consumed nonce 5');

  // The next batch uses the next nonce, not the reverted one.
  const next = clients(t, ['success']);
  publicClient.waitForTransactionReceipt = next.publicClient.waitForTransactionReceipt;
  publicClient.getTransactionReceipt = next.publicClient.getTransactionReceipt;
  await sender.sendPerformUpkeep({ trades: TRADES, timestamp: 2 });
  assert.equal(walletClient.sendTransaction.mock.calls[1].arguments[0].nonce, 6);
});

test('two batches sent at once never share a nonce', async (t) => {
  const { publicClient, walletClient } = clients(t, ['success']);
  const sender = createTxSender({ publicClient, walletClient, account: ACCOUNT, tradesUpKeepAddress: TRADES_UPKEEP, deadLetter: createDeadLetterStore(), registry: createRegistry() });
  await Promise.all([
    sender.sendPerformUpkeep({ trades: [TRADES[0]], timestamp: 1 }),
    sender.sendPerformUpkeep({ trades: [TRADES[1]], timestamp: 1 }),
  ]);
  const nonces = walletClient.sendTransaction.mock.calls.map((c) => c.arguments[0].nonce);
  assert.deepEqual(nonces, [5, 6]);
});

test('refuses to start without a trades upkeep address', () => {
  assert.throws(() => createTxSender({ tradesUpKeepAddress: undefined }), /tradesUpKeepAddress is required/);
});

// ---------------------------------------------------------------- deadlines, pipeline

/** A clock that only moves when the sender sleeps, so receipt timeouts run instantly. */
function fakeClock(start = 1_000_000) {
  const c = { t: start };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.t += ms;
  };
  return c;
}

const senderWith = (t, { publicClient, walletClient }, clock, deadLetter = createDeadLetterStore()) =>
  createTxSender({ publicClient, walletClient, account: ACCOUNT, tradesUpKeepAddress: TRADES_UPKEEP, deadLetter, registry: createRegistry(), now: clock.now, sleep: clock.sleep });

test('a send whose deadline already passed is never broadcast, and comes back expired, not dead-lettered', async (t) => {
  const c = clients(t, ['success']);
  const clock = fakeClock();
  const deadLetter = createDeadLetterStore();
  const sender = senderWith(t, c, clock, deadLetter);

  const result = await sender.sendPerformUpkeep({ trades: TRADES, timestamp: 1, deadlineMs: clock.t });
  assert.equal(result.ok, false);
  assert.equal(result.expired, true);
  assert.equal(result.attempts, 0, 'the engine reads this as "never reached the chain"');
  assert.equal(c.walletClient.sendTransaction.mock.callCount(), 0);
  assert.equal(deadLetter.size(), 0);
});

test('a stuck transaction is replaced after ~4 s, and neither bumped nor retried past its deadline', async (t) => {
  const c = clients(t, ['success']);
  c.publicClient.getTransactionReceipt = t.mock.fn(async () => null); // never mines
  const clock = fakeClock();
  const start = clock.t;
  const broadcastAt = [];
  const send = c.walletClient.sendTransaction;
  c.walletClient.sendTransaction = t.mock.fn(async (tx) => {
    broadcastAt.push(clock.t - start);
    return send(tx);
  });
  const deadLetter = createDeadLetterStore();

  const result = await senderWith(t, c, clock, deadLetter).sendPerformUpkeep({ trades: TRADES, timestamp: 1, deadlineMs: start + 6_000 });

  // One replacement inside the 6 s deadline; the one that would have gone out at 8 s could only
  // land a stale trigger, so it is not sent.
  assert.deepEqual(broadcastAt, [0, 4_000], 'one tx + 1 same-nonce replacement, then the deadline');
  assert.ok(c.walletClient.sendTransaction.mock.calls.every((x) => x.arguments[0].nonce === 5));
  assert.equal(result.ok, false);
  assert.equal(result.expired, true, 'no fresh attempt after the deadline');
  assert.equal(deadLetter.size(), 0);
});

test('batches are pipelined: the second goes out before the first has a receipt', async (t) => {
  const c = clients(t, ['success']);
  // The first receipt only exists once a second transaction has been broadcast. A serial
  // sender waits on it, times out and re-broadcasts nonce 5 before ever sending nonce 6.
  c.publicClient.getTransactionReceipt = t.mock.fn(async () => (c.walletClient.sendTransaction.mock.callCount() >= 2 ? { status: 'success' } : null));
  const sender = senderWith(t, c, fakeClock());
  const results = await Promise.all([
    sender.sendPerformUpkeep({ trades: [TRADES[0]], timestamp: 1 }),
    sender.sendPerformUpkeep({ trades: [TRADES[1]], timestamp: 1 }),
  ]);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(c.walletClient.sendTransaction.mock.calls.map((x) => x.arguments[0].nonce), [5, 6]);
});

test('a mined revert is reported as reverted, not expired', async (t) => {
  const c = clients(t, ['reverted']);
  const clock = fakeClock();
  const result = await senderWith(t, c, clock).sendPerformUpkeep({ trades: TRADES, timestamp: 1, deadlineMs: clock.t + 60_000 });
  assert.equal(result.reverted, true);
  assert.equal(result.expired, false);
  assert.equal(result.hash, '0xhash1');
});
