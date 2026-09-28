/**
 * One transaction sender per signing key, shared by the keeper and the automation bot.
 *
 *  - Serial queue. Every send for this key goes through one queue and runs to completion
 *    (mined, or given up on) before the next starts, so two concurrent callers can never
 *    be handed the same nonce. A later nonce cannot mine before an earlier one anyway, so
 *    serialising costs nothing a parallel sender would actually get.
 *  - Legacy type-0 transactions priced from eth_gasPrice (Whitechain has no EIP-1559).
 *  - Receipt wait with an explicit timeout. On timeout the SAME nonce is re-broadcast at
 *    1.2x the gas price, up to `maxBumps` times; every hash sent for that nonce is polled,
 *    because any one of them may be the one that mines.
 *  - A mined revert consumed its nonce. The local nonce advances past it exactly as it
 *    does for a success; re-using it would be refused with "nonce too low".
 *  - "nonce too low" / "already known" from the node means the local nonce is wrong, so
 *    it is re-read from the `pending` block tag before the next attempt.
 *  - Bounded retries, then a dead letter (see ./deadLetter.mjs), then `retryDeadLetters()`.
 *
 * The clients are viem-shaped but only these methods are used, so tests pass plain mocks:
 *   publicClient.getTransactionCount({ address, blockTag: 'pending' }) -> number
 *   publicClient.getGasPrice() -> bigint
 *   publicClient.getTransactionReceipt({ hash }) -> receipt | null (throws when not found)
 *   walletClient.sendTransaction({ account, to, data, value?, gas?, nonce, gasPrice, type: 'legacy' }) -> hash
 */

import { createRegistry } from '@whitespace/metrics';
import { createDeadLetterStore } from './deadLetter.mjs';
import { isAlreadyKnown, isNonceTooLow, isUnderpriced, reasonOf } from './errors.mjs';

export const DEFAULTS = Object.freeze({
  receiptTimeoutMs: 30_000,
  receiptPollMs: 1_000,
  maxBumps: 3,
  maxRetries: 3,
  bumpNumerator: 12n,
  bumpDenominator: 10n,
  retryOnRevert: true,
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toBigIntOrUndefined(v) {
  return v === undefined || v === null ? undefined : BigInt(v);
}

/**
 * @param {object} opts see ./index.d.ts for the full option list
 */
export function createTxSender({
  publicClient,
  walletClient,
  account,
  deadLetter = createDeadLetterStore(),
  registry = createRegistry(),
  metricsPrefix = 'txsender',
  receiptTimeoutMs = DEFAULTS.receiptTimeoutMs,
  receiptPollMs = DEFAULTS.receiptPollMs,
  maxBumps = DEFAULTS.maxBumps,
  maxRetries = DEFAULTS.maxRetries,
  bumpNumerator = DEFAULTS.bumpNumerator,
  bumpDenominator = DEFAULTS.bumpDenominator,
  retryOnRevert = DEFAULTS.retryOnRevert,
  now = () => Date.now(),
  sleep = defaultSleep,
  log = () => {},
}) {
  if (!publicClient || !walletClient || !account?.address) {
    throw new Error('createTxSender: publicClient, walletClient and account are required');
  }
  for (const [name, v] of Object.entries({ maxBumps, maxRetries })) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`createTxSender: ${name} must be a non-negative integer, got ${v}`);
  }
  if (!(receiptTimeoutMs > 0)) throw new Error(`createTxSender: receiptTimeoutMs must be > 0, got ${receiptTimeoutMs}`);
  if (bumpNumerator <= bumpDenominator) throw new Error('createTxSender: the gas bump must be > 1x');

  const counters = {
    sent: registry.counter(`${metricsPrefix}_tx_sent_total`, 'Transactions broadcast, replacements included'),
    replaced: registry.counter(`${metricsPrefix}_tx_replaced_total`, 'Same-nonce replacements broadcast after a receipt timeout'),
    confirmed: registry.counter(`${metricsPrefix}_tx_confirmed_total`, 'Transactions mined with status success'),
    reverted: registry.counter(`${metricsPrefix}_tx_reverted_total`, 'Transactions mined with status reverted (nonce consumed)'),
    nonceResyncs: registry.counter(`${metricsPrefix}_nonce_resyncs_total`, 'Times the local nonce was re-read from the pending block tag'),
    deadLettered: registry.counter(`${metricsPrefix}_tx_dead_lettered_total`, 'Sends given up on after every retry'),
  };
  const gauges = {
    deadLetterDepth: registry.gauge(`${metricsPrefix}_dead_letter_depth`, 'Unresolved dead letters held in memory'),
    queueDepth: registry.gauge(`${metricsPrefix}_queue_depth`, 'Sends waiting in or running through the queue'),
  };
  gauges.deadLetterDepth.set(deadLetter.size());

  /** Next nonce to use. Null until first read from the chain. */
  let nonce = null;
  let queue = Promise.resolve();
  let queued = 0;

  async function resync() {
    nonce = Number(await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }));
    counters.nonceResyncs.inc();
    return nonce;
  }

  /** A resync that cannot throw: on RPC failure the nonce is dropped and re-read next attempt. */
  async function resyncQuietly() {
    try {
      await resync();
    } catch (err) {
      nonce = null;
      log('warn', `nonce resync failed: ${reasonOf(err)}`);
    }
  }

  function bump(gasPrice) {
    return (gasPrice * bumpNumerator) / bumpDenominator;
  }

  async function broadcast(req, txNonce, gasPrice) {
    const hash = await walletClient.sendTransaction({
      account,
      to: req.to,
      data: req.data,
      ...(req.value !== undefined ? { value: req.value } : {}),
      ...(req.gas !== undefined ? { gas: req.gas } : {}),
      nonce: txNonce,
      gasPrice,
      type: 'legacy',
    });
    counters.sent.inc();
    return hash;
  }

  async function findReceipt(hashes) {
    for (const hash of hashes) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        if (receipt) return { hash, receipt };
      } catch {
        // Not mined yet (viem throws TransactionReceiptNotFoundError), or a transient RPC
        // error: both mean "ask again on the next poll".
      }
    }
    return null;
  }

  /** One nonce, one or more same-nonce broadcasts, until a receipt or the last timeout. */
  async function attemptOnce(req) {
    if (nonce === null) await resync();
    const txNonce = nonce;
    let gasPrice = await publicClient.getGasPrice();

    const hashes = [];
    try {
      hashes.push(await broadcast(req, txNonce, gasPrice));
    } catch (err) {
      if (isNonceTooLow(err) || isAlreadyKnown(err)) await resyncQuietly();
      // Any other refusal (estimateGas revert, insufficient funds, RPC down) never reached
      // the pool, so the nonce was not consumed and stays where it is.
      return { ok: false, reason: reasonOf(err) };
    }

    let bumps = 0;
    let deadline = now() + receiptTimeoutMs;
    for (;;) {
      const found = await findReceipt(hashes);
      if (found) {
        // Mined — success or revert, the nonce is spent either way.
        nonce = txNonce + 1;
        if (found.receipt.status === 'success') {
          counters.confirmed.inc();
          return { ok: true, hash: found.hash, receipt: found.receipt, nonce: txNonce, replacements: bumps };
        }
        counters.reverted.inc();
        return { ok: false, reverted: true, hash: found.hash, reason: `reverted: ${found.hash}` };
      }
      if (now() < deadline) {
        await sleep(receiptPollMs);
        continue;
      }
      if (bumps >= maxBumps) {
        // Still pending after every replacement. It stays in the pool; move the local nonce
        // to wherever the node now says it is (past it, if the node still holds it).
        await resyncQuietly();
        return { ok: false, reason: `receipt_timeout: no receipt for nonce ${txNonce} after ${bumps} replacement(s)` };
      }
      bumps += 1;
      let networkPrice = 0n;
      try {
        networkPrice = await publicClient.getGasPrice();
      } catch {
        // keep the bumped price alone
      }
      const bumped = bump(gasPrice);
      gasPrice = bumped > networkPrice ? bumped : networkPrice;
      try {
        hashes.push(await broadcast(req, txNonce, gasPrice));
        counters.replaced.inc();
        log('warn', `nonce ${txNonce}: no receipt in ${receiptTimeoutMs}ms, replaced at gasPrice=${gasPrice} (bump ${bumps}/${maxBumps})`);
      } catch (err) {
        // "nonce too low": one of our earlier hashes has most likely just mined — keep
        // polling them. "underpriced"/"already known": the next bump goes higher. Anything
        // else: the hashes already sent are still the ones to watch.
        if (!isNonceTooLow(err) && !isUnderpriced(err) && !isAlreadyKnown(err)) {
          log('warn', `nonce ${txNonce}: replacement refused: ${reasonOf(err)}`);
        }
      }
      deadline = now() + receiptTimeoutMs;
    }
  }

  async function runJob(req) {
    let last = { ok: false, reason: 'unknown' };
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        last = await attemptOnce(req);
      } catch (err) {
        // RPC failure reading the nonce or gas price: nothing was broadcast.
        last = { ok: false, reason: reasonOf(err) };
      }
      if (last.ok) return { ...last, attempts: attempt };
      if (last.reverted && !retryOnRevert) return { ...last, attempts: attempt };
      log('warn', `${req.key ?? req.to}: attempt ${attempt}/${maxRetries + 1} failed: ${last.reason}`);
    }
    return { ...last, attempts: maxRetries + 1 };
  }

  function enqueue(fn) {
    queued += 1;
    gauges.queueDepth.set(queued);
    const run = queue.then(fn).finally(() => {
      queued -= 1;
      gauges.queueDepth.set(queued);
    });
    queue = run.catch(() => {});
    return run;
  }

  function validate(req) {
    if (!req || typeof req.to !== 'string' || typeof req.data !== 'string') {
      throw new Error('send: { to, data } are required');
    }
  }

  /**
   * @param {{ to: `0x${string}`, data: `0x${string}`, value?: bigint, gas?: bigint, key?: string, meta?: object }} req
   */
  function send(req) {
    validate(req);
    return enqueue(async () => {
      const result = await runJob(req);
      if (result.ok) return result;
      const entry = deadLetter.add({
        key: req.key ?? null,
        meta: req.meta ?? null,
        request: { to: req.to, data: req.data, value: req.value, gas: req.gas },
        reason: result.reason,
        attempts: result.attempts,
      });
      counters.deadLettered.inc();
      gauges.deadLetterDepth.set(deadLetter.size());
      log('error', `${req.key ?? req.to}: dead-lettered after ${result.attempts} attempt(s): ${result.reason}`);
      return { ...result, deadLettered: true, deadLetterId: entry.id };
    });
  }

  /**
   * Re-sends every unresolved dead letter (or those `filter` accepts). A delivered one is
   * resolved; a failed one stays as it was — it is not dead-lettered a second time.
   * @param {{ filter?: (entry: object) => boolean }} [opts]
   */
  async function retryDeadLetters({ filter = () => true } = {}) {
    const entries = deadLetter.list().filter(filter);
    const results = await Promise.all(
      entries.map((entry) =>
        enqueue(async () => {
          const req = {
            ...entry.request,
            value: toBigIntOrUndefined(entry.request?.value),
            gas: toBigIntOrUndefined(entry.request?.gas),
            key: entry.key ?? undefined,
          };
          const result = await runJob(req);
          if (result.ok) {
            deadLetter.resolve(entry.id);
            gauges.deadLetterDepth.set(deadLetter.size());
          }
          return { id: entry.id, ...result };
        }),
      ),
    );
    const delivered = results.filter((r) => r.ok).length;
    return { retried: results.length, delivered, failed: results.length - delivered, results };
  }

  return {
    send,
    retryDeadLetters,
    resync,
    deadLetter,
    registry,
    counters,
    gauges,
    get nonce() {
      return nonce;
    },
    get queued() {
      return queued;
    },
  };
}
