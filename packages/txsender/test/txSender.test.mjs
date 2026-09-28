import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry } from '@whitespace/metrics';
import { createTxSender } from '../src/txSender.mjs';
import { createDeadLetterStore } from '../src/deadLetter.mjs';

const ACCOUNT = { address: '0x1234567890123456789012345678901234567890' };
const TO = '0x9999999999999999999999999999999999999999';
const GWEI = 1_000_000_000n;

/**
 * A fake chain. `policy(tx, index)` decides what happens to each broadcast:
 *   'success' | 'reverted' -> mined immediately with that status
 *   'pending'              -> never mined unless the test mines it later via `mine()`
 *   an Error               -> the node refuses the broadcast
 * A virtual clock backs `now`/`sleep`, so receipt timeouts run instantly.
 */
function fakeChain({ pendingNonce = 5, gasPrice = GWEI, policy = () => 'success' } = {}) {
  let clock = 0;
  const chain = {
    pendingNonce,
    gasPrice,
    policy,
    sent: [],
    receipts: new Map(),
    nonceReads: 0,
    failNonceReads: 0,
    onSleep: null,
    mine(hash, status = 'success') {
      chain.receipts.set(hash, { status, transactionHash: hash });
    },
  };
  chain.publicClient = {
    async getTransactionCount(args) {
      assert.equal(args.blockTag, 'pending');
      chain.nonceReads += 1;
      if (chain.failNonceReads > 0) {
        chain.failNonceReads -= 1;
        throw new Error('rpc down');
      }
      return chain.pendingNonce;
    },
    async getGasPrice() {
      return chain.gasPrice;
    },
    async getTransactionReceipt({ hash }) {
      const r = chain.receipts.get(hash);
      if (!r) throw new Error(`Transaction receipt with hash "${hash}" could not be found`);
      return r;
    },
  };
  chain.walletClient = {
    async sendTransaction(args) {
      const index = chain.sent.length;
      const outcome = chain.policy(args, index);
      if (outcome instanceof Error) throw outcome;
      const hash = `0x${(index + 1).toString(16).padStart(64, '0')}`;
      chain.sent.push({ ...args, hash });
      if (outcome === 'success' || outcome === 'reverted') chain.mine(hash, outcome);
      return hash;
    },
  };
  chain.now = () => clock;
  chain.sleep = async (ms) => {
    clock += ms;
    chain.onSleep?.(clock);
    await Promise.resolve();
  };
  return chain;
}

function makeSender(chain, opts = {}) {
  return createTxSender({
    publicClient: chain.publicClient,
    walletClient: chain.walletClient,
    account: ACCOUNT,
    now: chain.now,
    sleep: chain.sleep,
    receiptTimeoutMs: 1_000,
    receiptPollMs: 100,
    ...opts,
  });
}

const req = (key = 'job') => ({ to: TO, data: '0xabcdef', key });

test('a first-try success sends a legacy tx at eth_gasPrice with the pending nonce and advances it', async () => {
  const chain = fakeChain();
  const sender = makeSender(chain);
  const result = await sender.send(req());

  assert.equal(result.ok, true);
  assert.equal(result.nonce, 5);
  assert.equal(result.attempts, 1);
  assert.equal(result.replacements, 0);
  assert.equal(sender.nonce, 6);
  const [tx] = chain.sent;
  assert.equal(tx.type, 'legacy');
  assert.equal(tx.gasPrice, GWEI);
  assert.equal(tx.nonce, 5);
  assert.equal(tx.to, TO);
  assert.equal(tx.account, ACCOUNT);
  assert.equal('value' in tx, false);
  assert.equal(sender.counters.sent.value(), 1);
  assert.equal(sender.counters.confirmed.value(), 1);
});

test('value and gas are forwarded when given', async () => {
  const chain = fakeChain();
  await makeSender(chain).send({ ...req(), value: 7n, gas: 300_000n });
  assert.equal(chain.sent[0].value, 7n);
  assert.equal(chain.sent[0].gas, 300_000n);
});

test('concurrent callers get distinct consecutive nonces — never the same one', async () => {
  // Each tx stays pending for a few polls before mining, which is exactly when the old
  // sender let a second caller read the same cached nonce.
  const chain = fakeChain({ policy: () => 'pending' });
  chain.onSleep = () => {
    for (const tx of chain.sent) if (!chain.receipts.has(tx.hash)) chain.mine(tx.hash);
  };
  const sender = makeSender(chain);
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => sender.send(req(`job-${i}`))));

  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 6, 7, 8, 9]);
  assert.equal(sender.nonce, 10);
  assert.equal(chain.nonceReads, 1);
});

test('the queue runs strictly one job at a time: the next broadcast waits for the previous receipt', async () => {
  const chain = fakeChain({ policy: () => 'pending' });
  const broadcastsWhenMined = [];
  chain.onSleep = () => {
    for (const tx of chain.sent) {
      if (!chain.receipts.has(tx.hash)) {
        broadcastsWhenMined.push(chain.sent.length);
        chain.mine(tx.hash);
      }
    }
  };
  const sender = makeSender(chain);
  await Promise.all([sender.send(req('a')), sender.send(req('b'))]);
  assert.deepEqual(broadcastsWhenMined, [1, 2]);
});

test('a mined revert consumes the nonce: the next send uses nonce + 1', async () => {
  const chain = fakeChain({ policy: (_tx, i) => (i === 0 ? 'reverted' : 'success') });
  const sender = makeSender(chain, { retryOnRevert: false });

  const first = await sender.send(req('a'));
  assert.equal(first.ok, false);
  assert.equal(first.reverted, true);
  assert.equal(first.attempts, 1);
  assert.equal(sender.nonce, 6);

  const second = await sender.send(req('b'));
  assert.equal(second.ok, true);
  assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 6]);
  assert.equal(chain.nonceReads, 1, 'no resync needed — the local nonce was already right');
  assert.equal(sender.counters.reverted.value(), 1);
});

test('with retryOnRevert, the retry after a revert goes out at the next nonce', async () => {
  const chain = fakeChain({ policy: (_tx, i) => (i === 0 ? 'reverted' : 'success') });
  const sender = makeSender(chain);
  const result = await sender.send(req());
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 6]);
});

test('a receipt timeout re-broadcasts the SAME nonce at 1.2x gas, and the replacement landing is success', async () => {
  const chain = fakeChain({ policy: (_tx, i) => (i === 0 ? 'pending' : 'success') });
  const sender = makeSender(chain);
  const result = await sender.send(req());

  assert.equal(result.ok, true);
  assert.equal(result.replacements, 1);
  assert.equal(result.hash, chain.sent[1].hash);
  assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 5]);
  assert.deepEqual(chain.sent.map((t) => t.gasPrice), [GWEI, (GWEI * 12n) / 10n]);
  assert.equal(sender.nonce, 6);
  assert.equal(sender.counters.replaced.value(), 1);
  assert.equal(sender.counters.sent.value(), 2);
});

test('no replacement before the timeout has elapsed', async () => {
  const chain = fakeChain({ policy: () => 'pending' });
  chain.onSleep = (clock) => {
    if (clock === 900) chain.mine(chain.sent[0].hash); // mines just inside the 1,000 ms window
  };
  const sender = makeSender(chain);
  const result = await sender.send(req());
  assert.equal(result.ok, true);
  assert.equal(chain.sent.length, 1);
  assert.equal(result.replacements, 0);
});

test('if the ORIGINAL mines after a replacement was sent, that is still success (every hash is watched)', async () => {
  const chain = fakeChain({ policy: () => 'pending' });
  chain.onSleep = () => {
    if (chain.sent.length === 2) chain.mine(chain.sent[0].hash);
  };
  const sender = makeSender(chain);
  const result = await sender.send(req());
  assert.equal(result.ok, true);
  assert.equal(result.hash, chain.sent[0].hash);
  assert.equal(sender.nonce, 6);
});

test('bumps are capped: never-mined gives maxBumps replacements, then a resync and a dead letter', async () => {
  const chain = fakeChain({ policy: () => 'pending' });
  const sender = makeSender(chain, { maxBumps: 2, maxRetries: 0 });
  // The node still holds the stuck tx, so its pending count now includes it.
  chain.onSleep = () => {
    chain.pendingNonce = 6;
  };
  const result = await sender.send(req());

  assert.equal(result.ok, false);
  assert.match(result.reason, /receipt_timeout/);
  assert.equal(result.deadLettered, true);
  assert.deepEqual(chain.sent.map((t) => t.gasPrice), [GWEI, 1_200_000_000n, 1_440_000_000n]);
  assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 5, 5]);
  assert.equal(sender.nonce, 6, 'resynced from pending so the next job does not collide with the stuck tx');
  assert.equal(sender.counters.replaced.value(), 2);
});

test('a replacement never goes below the current network gas price', async () => {
  const chain = fakeChain({ policy: (_tx, i) => (i === 0 ? 'pending' : 'success') });
  chain.onSleep = () => {
    chain.gasPrice = 5n * GWEI; // network spiked while we waited
  };
  const sender = makeSender(chain);
  await sender.send(req());
  assert.equal(chain.sent[1].gasPrice, 5n * GWEI);
});

test('an "underpriced" replacement refusal keeps polling and the next bump goes higher', async () => {
  const chain = fakeChain({
    policy: (_tx, i) => {
      if (i === 0) return 'pending';
      if (i === 1) return 'success';
      return 'pending';
    },
  });
  let refusals = 1;
  const inner = chain.walletClient.sendTransaction;
  chain.walletClient.sendTransaction = async (args) => {
    if (chain.sent.length === 1 && refusals-- > 0) throw new Error('replacement transaction underpriced');
    return inner(args);
  };
  const sender = makeSender(chain);
  const result = await sender.send(req());
  assert.equal(result.ok, true);
  assert.equal(result.replacements, 2);
  assert.equal(chain.sent[1].gasPrice, 1_440_000_000n);
});

for (const message of ['nonce too low', 'already known']) {
  test(`"${message}" resyncs the nonce from pending and retries at the corrected nonce`, async () => {
    const chain = fakeChain({ policy: (_tx, i) => (i === 0 ? new Error(message) : 'success') });
    const inner = chain.walletClient.sendTransaction;
    chain.walletClient.sendTransaction = async (args) => {
      try {
        return await inner(args);
      } catch (err) {
        chain.pendingNonce = 9; // someone else used 5..8
        chain.policy = () => 'success';
        throw err;
      }
    };
    const sender = makeSender(chain);
    const result = await sender.send(req());
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.nonce, 9);
    assert.equal(sender.nonce, 10);
    assert.equal(chain.nonceReads, 2);
  });
}

test('any other refusal leaves the nonce alone (nothing reached the pool) and is retried', async () => {
  const tried = [];
  const chain = fakeChain({
    policy: (tx) => {
      tried.push(tx.nonce);
      return tried.length <= 2 ? new Error('insufficient funds for gas * price + value') : 'success';
    },
  });
  const sender = makeSender(chain);
  const result = await sender.send(req());
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(tried, [5, 5, 5]);
  assert.equal(chain.nonceReads, 1);
});

test('retries are bounded: maxRetries + 1 attempts, then a persisted dead letter with the request', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'txsender-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'dlq.jsonl');
  const chain = fakeChain({ policy: () => 'reverted' });
  const sender = makeSender(chain, { maxRetries: 2, deadLetter: createDeadLetterStore({ filePath }) });

  const result = await sender.send({ ...req('order-3'), value: 1n, meta: { orderId: '3' } });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.deadLettered, true);
  assert.equal(chain.sent.length, 3);
  assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 6, 7], 'each reverted attempt consumed its nonce');
  const [entry] = readFileSync(filePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entry.id, result.deadLetterId);
  assert.equal(entry.key, 'order-3');
  assert.deepEqual(entry.meta, { orderId: '3' });
  assert.deepEqual(entry.request, { to: TO, data: '0xabcdef', value: '1' });
  assert.equal(entry.attempts, 3);
  assert.match(entry.reason, /reverted/);
  assert.equal(sender.counters.deadLettered.value(), 1);
  assert.equal(sender.gauges.deadLetterDepth.value(), 1);
});

test('an RPC failure reading the nonce is an attempt, not a crash, and the queue keeps going', async () => {
  const chain = fakeChain();
  chain.failNonceReads = 1;
  const sender = makeSender(chain);
  const result = await sender.send(req());
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test('a dead-lettered job does not block the next one in the queue', async () => {
  const chain = fakeChain({ policy: (_tx, i) => (i === 0 ? 'reverted' : 'success') });
  const sender = makeSender(chain, { maxRetries: 0 });
  const [a, b] = await Promise.all([sender.send(req('a')), sender.send(req('b'))]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, true);
  assert.equal(sender.queued, 0);
  assert.equal(sender.gauges.queueDepth.value(), 0);
});

test('retryDeadLetters re-sends, resolves what lands, and does not duplicate what fails again', async () => {
  const chain = fakeChain({ policy: () => 'reverted' });
  const sender = makeSender(chain, { maxRetries: 0 });
  await sender.send({ ...req('a'), gas: 21_000n });
  await sender.send(req('b'));
  assert.equal(sender.deadLetter.size(), 2);

  chain.policy = (tx) => (tx.gas === 21_000n ? 'success' : 'reverted');
  const outcome = await sender.retryDeadLetters();

  assert.equal(outcome.retried, 2);
  assert.equal(outcome.delivered, 1);
  assert.equal(outcome.failed, 1);
  assert.deepEqual(sender.deadLetter.list().map((e) => e.key), ['b']);
  assert.equal(sender.deadLetter.total, 2, 'the failed retry did not add a second entry');
  assert.equal(sender.gauges.deadLetterDepth.value(), 1);
  assert.equal(chain.sent.at(-2).gas, 21_000n, 'the stored gas string was restored as a bigint');
});

test('retryDeadLetters honours a filter and is a no-op on an empty store', async () => {
  const chain = fakeChain({ policy: () => 'reverted' });
  const sender = makeSender(chain, { maxRetries: 0 });
  assert.deepEqual(await sender.retryDeadLetters(), { retried: 0, delivered: 0, failed: 0, results: [] });
  await sender.send(req('a'));
  await sender.send(req('b'));
  chain.policy = () => 'success';
  const outcome = await sender.retryDeadLetters({ filter: (e) => e.key === 'b' });
  assert.equal(outcome.retried, 1);
  assert.deepEqual(sender.deadLetter.list().map((e) => e.key), ['a']);
});

test('metrics register on a shared registry under the given prefix', async () => {
  const registry = createRegistry();
  const chain = fakeChain();
  const sender = makeSender(chain, { registry, metricsPrefix: 'keeper' });
  await sender.send(req());
  const text = registry.render();
  for (const name of ['keeper_tx_sent_total 1', 'keeper_tx_confirmed_total 1', 'keeper_tx_replaced_total', 'keeper_tx_reverted_total', 'keeper_tx_dead_lettered_total', 'keeper_dead_letter_depth 0']) {
    assert.ok(text.includes(name), `missing ${name}`);
  }
});

test('invalid requests and options are refused up front', async () => {
  const chain = fakeChain();
  const sender = makeSender(chain);
  assert.throws(() => sender.send({ data: '0x' }), /to, data/);
  assert.throws(() => makeSender(chain, { maxRetries: -1 }), /maxRetries/);
  assert.throws(() => makeSender(chain, { maxBumps: 1.5 }), /maxBumps/);
  assert.throws(() => makeSender(chain, { receiptTimeoutMs: 0 }), /receiptTimeoutMs/);
  assert.throws(() => makeSender(chain, { bumpNumerator: 10n }), /bump/);
  assert.throws(() => createTxSender({ publicClient: chain.publicClient }), /required/);
});
