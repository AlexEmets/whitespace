import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, decodeFunctionData } from 'viem';
import { createTxSender } from '../src/txSender.mjs';
import { TRADES_UPKEEP_ABI } from '../src/abi.mjs';
import { createDeadLetterQueue } from '../src/deadLetter.mjs';

const ACCOUNT = { address: '0x1234567890123456789012345678901234567890' };
const TRADES_UPKEEP = '0x9999999999999999999999999999999999999999';
const TRADES = [
  { trader: '0x1111111111111111111111111111111111111111', pairIndex: 0, index: 0, limitOrder: 2 },
  { trader: '0x2222222222222222222222222222222222222222', pairIndex: 1, index: 3, limitOrder: 3 },
];

test('sendPerformUpkeep succeeds on the first attempt and advances the cached nonce', async (t) => {
  const publicClient = {
    getTransactionCount: t.mock.fn(async () => 5),
    getGasPrice: t.mock.fn(async () => 1_000_000_000n),
    waitForTransactionReceipt: t.mock.fn(async () => ({ status: 'success' })),
  };
  const walletClient = { sendTransaction: t.mock.fn(async () => '0xhash1') };
  const deadLetter = createDeadLetterQueue();
  const sender = createTxSender({ publicClient, walletClient, account: ACCOUNT, tradesUpKeepAddress: TRADES_UPKEEP, deadLetter });

  const result = await sender.sendPerformUpkeep({ trades: TRADES, timestamp: 1_757_325_600 });

  assert.equal(result.ok, true);
  assert.equal(result.hash, '0xhash1');
  assert.equal(sender.nonce, 6);
  assert.equal(walletClient.sendTransaction.mock.calls[0].arguments[0].type, 'legacy');
  assert.equal(walletClient.sendTransaction.mock.calls[0].arguments[0].to, TRADES_UPKEEP);
  assert.equal(deadLetter.size(), 0);

  // The whole batch goes out as one performUpkeep(abi.encode(SimplifiedTradeId[], timestamp)).
  const { functionName, args } = decodeFunctionData({ abi: TRADES_UPKEEP_ABI, data: walletClient.sendTransaction.mock.calls[0].arguments[0].data });
  assert.equal(functionName, 'performUpkeep');
  const [trades, timestamp] = decodeAbiParameters(
    [{ type: 'tuple[]', components: [{ name: 'trader', type: 'address' }, { name: 'pairId', type: 'uint256' }, { name: 'index', type: 'uint256' }, { name: 'limitOrder', type: 'uint8' }] }, { type: 'uint256' }],
    args[0],
  );
  assert.equal(timestamp, 1_757_325_600n);
  assert.deepEqual(
    trades.map((x) => [x.trader.toLowerCase(), x.pairId, x.index, x.limitOrder]),
    TRADES.map((x) => [x.trader, BigInt(x.pairIndex), BigInt(x.index), x.limitOrder]),
  );
});

test('sendPerformUpkeep bumps gas price 1.2x and retries after a reverted receipt, then succeeds', async (t) => {
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

  const result = await sender.sendPerformUpkeep({ trades: TRADES, timestamp: 1 });

  assert.equal(result.ok, true);
  assert.equal(sentGasPrices.length, 2);
  assert.equal(sentGasPrices[1], (1_000_000_000n * 12n) / 10n);
});

test('sendPerformUpkeep dead-letters the whole batch after exhausting retries on repeated reverts', async (t) => {
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

  const result = await sender.sendPerformUpkeep({ trades: TRADES, timestamp: 1 });

  assert.equal(result.ok, false);
  assert.equal(deadLetter.size(), 1);
  assert.deepEqual(deadLetter.list()[0].trades, TRADES);
  assert.equal(deadLetter.list()[0].timestamp, 1);
  assert.equal(walletClient.sendTransaction.mock.callCount(), 3);
});
