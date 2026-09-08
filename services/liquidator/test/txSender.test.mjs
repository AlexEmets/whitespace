import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTxSender } from '../src/txSender.mjs';
import { createDeadLetterQueue } from '../src/deadLetter.mjs';

const ACCOUNT = { address: '0x1234567890123456789012345678901234567890' };
const TRADES_UPKEEP = '0x9999999999999999999999999999999999999999';
const CANDIDATE = { trader: '0x1111111111111111111111111111111111111111', pairIndex: 0, index: 0 };

test('submitLiquidation succeeds on the first attempt and advances the cached nonce', async (t) => {
  const publicClient = {
    getTransactionCount: t.mock.fn(async () => 5),
    getGasPrice: t.mock.fn(async () => 1_000_000_000n),
    waitForTransactionReceipt: t.mock.fn(async () => ({ status: 'success' })),
  };
  const walletClient = { sendTransaction: t.mock.fn(async () => '0xhash1') };
  const deadLetter = createDeadLetterQueue();
  const sender = createTxSender({ publicClient, walletClient, account: ACCOUNT, tradesUpKeepAddress: TRADES_UPKEEP, deadLetter });

  const result = await sender.submitLiquidation(CANDIDATE, 1_757_325_600);

  assert.equal(result.ok, true);
  assert.equal(result.hash, '0xhash1');
  assert.equal(sender.nonce, 6);
  assert.equal(walletClient.sendTransaction.mock.calls[0].arguments[0].type, 'legacy');
  assert.equal(walletClient.sendTransaction.mock.calls[0].arguments[0].to, TRADES_UPKEEP);
  assert.equal(deadLetter.size(), 0);
});

test('submitLiquidation bumps gas price 1.2x and retries after a reverted receipt, then succeeds', async (t) => {
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
  const sender = createTxSender({ publicClient, walletClient, account: ACCOUNT, tradesUpKeepAddress: TRADES_UPKEEP, deadLetter });

  const result = await sender.submitLiquidation(CANDIDATE, 1);

  assert.equal(result.ok, true);
  assert.equal(sentGasPrices.length, 2);
  assert.equal(sentGasPrices[1], (1_000_000_000n * 12n) / 10n);
});

test('submitLiquidation dead-letters the candidate after exhausting retries on repeated reverts', async (t) => {
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
    tradesUpKeepAddress: TRADES_UPKEEP,
    deadLetter,
    maxRetries: 2,
  });

  const result = await sender.submitLiquidation(CANDIDATE, 1);

  assert.equal(result.ok, false);
  assert.equal(deadLetter.size(), 1);
  assert.equal(deadLetter.list()[0].trader, CANDIDATE.trader);
  assert.equal(walletClient.sendTransaction.mock.callCount(), 3);
});
