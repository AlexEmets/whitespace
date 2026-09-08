import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTxSender } from '../src/txSender.mjs';
import { createDeadLetterQueue } from '../src/deadLetter.mjs';

const ACCOUNT = { address: '0x1234567890123456789012345678901234567890' };
const UPKEEP = '0x9999999999999999999999999999999999999999';

test('send() succeeds on the first attempt and advances the cached nonce', async (t) => {
  const publicClient = {
    getTransactionCount: t.mock.fn(async () => 5),
    getGasPrice: t.mock.fn(async () => 1_000_000_000n),
    waitForTransactionReceipt: t.mock.fn(async () => ({ status: 'success' })),
  };
  const walletClient = { sendTransaction: t.mock.fn(async () => '0xhash1') };
  const deadLetter = createDeadLetterQueue();
  const sender = createTxSender({ publicClient, walletClient, account: ACCOUNT, priceUpKeepAddress: UPKEEP, deadLetter });

  const result = await sender.send({ orderId: 1n, performData: '0x1234' });

  assert.equal(result.ok, true);
  assert.equal(result.hash, '0xhash1');
  assert.equal(sender.nonce, 6);
  assert.equal(walletClient.sendTransaction.mock.callCount(), 1);
  assert.equal(walletClient.sendTransaction.mock.calls[0].arguments[0].type, 'legacy');
  assert.equal(deadLetter.size(), 0);
});

test('send() bumps gas price 1.2x and retries after a reverted receipt, then succeeds', async (t) => {
  let receiptCall = 0;
  const publicClient = {
    getTransactionCount: t.mock.fn(async () => 5),
    getGasPrice: t.mock.fn(async () => 1_000_000_000n),
    waitForTransactionReceipt: t.mock.fn(async () => {
      receiptCall++;
      return receiptCall === 1 ? { status: 'reverted' } : { status: 'success' };
    }),
  };
  const sentGasPrices = [];
  const walletClient = {
    sendTransaction: t.mock.fn(async (args) => {
      sentGasPrices.push(args.gasPrice);
      return `0xhash${sentGasPrices.length}`;
    }),
  };
  const deadLetter = createDeadLetterQueue();
  const sender = createTxSender({ publicClient, walletClient, account: ACCOUNT, priceUpKeepAddress: UPKEEP, deadLetter });

  const result = await sender.send({ orderId: 2n, performData: '0x1234' });

  assert.equal(result.ok, true);
  assert.equal(sentGasPrices.length, 2);
  assert.equal(sentGasPrices[0], 1_000_000_000n);
  assert.equal(sentGasPrices[1], (1_000_000_000n * 12n) / 10n); // exact 1.2x bump
  assert.equal(deadLetter.size(), 0);
});

test('send() dead-letters the order after exhausting retries on repeated reverts', async (t) => {
  const publicClient = {
    getTransactionCount: t.mock.fn(async () => 5),
    getGasPrice: t.mock.fn(async () => 1_000_000_000n),
    waitForTransactionReceipt: t.mock.fn(async () => ({ status: 'reverted' })),
  };
  const walletClient = { sendTransaction: t.mock.fn(async () => '0xhash') };
  const deadLetter = createDeadLetterQueue();
  const sender = createTxSender({
    publicClient,
    walletClient,
    account: ACCOUNT,
    priceUpKeepAddress: UPKEEP,
    deadLetter,
    maxRetries: 2,
  });

  const result = await sender.send({ orderId: 3n, performData: '0x1234' });

  assert.equal(result.ok, false);
  assert.equal(deadLetter.size(), 1);
  assert.equal(deadLetter.list()[0].orderId, '3');
  assert.equal(walletClient.sendTransaction.mock.callCount(), 3); // maxRetries + 1 attempts
});

test('send() refreshes the nonce (without a gas bump) on a nonce-related send failure', async (t) => {
  let nonceCalls = 0;
  const publicClient = {
    getTransactionCount: t.mock.fn(async () => {
      nonceCalls++;
      return nonceCalls === 1 ? 5 : 9;
    }),
    getGasPrice: t.mock.fn(async () => 1_000_000_000n),
    waitForTransactionReceipt: t.mock.fn(async () => ({ status: 'success' })),
  };
  const sentNonces = [];
  const sentGasPrices = [];
  let sendCalls = 0;
  const walletClient = {
    sendTransaction: t.mock.fn(async (args) => {
      sendCalls++;
      sentNonces.push(args.nonce);
      sentGasPrices.push(args.gasPrice);
      if (sendCalls === 1) throw new Error('nonce too low');
      return '0xhash';
    }),
  };
  const deadLetter = createDeadLetterQueue();
  const sender = createTxSender({ publicClient, walletClient, account: ACCOUNT, priceUpKeepAddress: UPKEEP, deadLetter });

  const result = await sender.send({ orderId: 4n, performData: '0x1234' });

  assert.equal(result.ok, true);
  assert.deepEqual(sentNonces, [5, 9]);
  assert.deepEqual(sentGasPrices, [1_000_000_000n, 1_000_000_000n]); // no bump on the nonce-error path
});
