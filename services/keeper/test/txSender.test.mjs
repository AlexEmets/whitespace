import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { createDeadLetterStore } from '@whitespace/txsender';
import { createTxSender } from '../src/txSender.mjs';
import { PRICE_UPKEEP_ABI } from '../src/abi.mjs';

const ACCOUNT = { address: '0x1234567890123456789012345678901234567890' };
const UPKEEP = '0x9999999999999999999999999999999999999999';

/**
 * Receipts come from `statuses` in broadcast order; a tx stays pending for `pendingPolls`
 * receipt lookups first, which is the window in which two unserialised sends collide.
 */
function fakeClients({ startNonce = 5, statuses = [], pendingPolls = 0 } = {}) {
  const sent = [];
  const polls = new Map();
  const receiptOf = (hash) => {
    const n = (polls.get(hash) ?? 0) + 1;
    polls.set(hash, n);
    if (n <= pendingPolls) return null;
    const index = sent.findIndex((t) => t.hash === hash);
    return { status: statuses[index] ?? 'success', transactionHash: hash };
  };
  const publicClient = {
    getTransactionCount: async () => startNonce,
    getGasPrice: async () => 1_000_000_000n,
    async getTransactionReceipt({ hash }) {
      const r = receiptOf(hash);
      if (!r) throw new Error('receipt not found');
      return r;
    },
    async waitForTransactionReceipt({ hash }) {
      let r;
      while (!(r = receiptOf(hash))) await new Promise((res) => setTimeout(res, 1));
      return r;
    },
  };
  const walletClient = {
    async sendTransaction(args) {
      const hash = `0x${(sent.length + 1).toString(16).padStart(64, '0')}`;
      sent.push({ ...args, hash });
      return hash;
    },
  };
  return { publicClient, walletClient, sent };
}

function makeSender(clients, opts = {}) {
  return createTxSender({
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    account: ACCOUNT,
    priceUpKeepAddress: UPKEEP,
    deadLetter: createDeadLetterStore(),
    receiptPollMs: 1,
    ...opts,
  });
}

test('send() calls performUpkeep(performData) on the price upkeep as a legacy tx', async () => {
  const clients = fakeClients();
  const sender = makeSender(clients);
  const result = await sender.send({ orderId: 1n, performData: '0x1234' });

  assert.equal(result.ok, true);
  assert.equal(sender.nonce, 6);
  const [tx] = clients.sent;
  assert.equal(tx.to, UPKEEP);
  assert.equal(tx.type, 'legacy');
  const decoded = decodeFunctionData({ abi: PRICE_UPKEEP_ABI, data: tx.data });
  assert.equal(decoded.functionName, 'performUpkeep');
  assert.deepEqual(decoded.args, ['0x1234']);
});

test('two orders handled at once never share a nonce', async () => {
  const clients = fakeClients({ pendingPolls: 2 });
  const sender = makeSender(clients);
  const results = await Promise.all([
    sender.send({ orderId: 1n, performData: '0x01' }),
    sender.send({ orderId: 2n, performData: '0x02' }),
  ]);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(clients.sent.map((t) => t.nonce), [5, 6]);
});

test('a mined revert consumes its nonce: the next order goes out at nonce + 1', async () => {
  const clients = fakeClients({ statuses: ['reverted'] });
  const sender = makeSender(clients, { maxRetries: 0 });
  const first = await sender.send({ orderId: 1n, performData: '0x01' });
  assert.equal(first.ok, false);
  await sender.send({ orderId: 2n, performData: '0x02' });
  assert.deepEqual(clients.sent.map((t) => t.nonce), [5, 6]);
});

test('a failed order is dead-lettered with its orderId', async () => {
  const clients = fakeClients({ statuses: ['reverted', 'reverted'] });
  const deadLetter = createDeadLetterStore();
  const sender = makeSender(clients, { maxRetries: 1, deadLetter });
  const result = await sender.send({ orderId: 3n, performData: '0x03' });
  assert.equal(result.ok, false);
  assert.equal(deadLetter.size(), 1);
  const [entry] = deadLetter.list();
  assert.equal(entry.key, 'order-3');
  assert.deepEqual(entry.meta, { orderId: '3' });
});
