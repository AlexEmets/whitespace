/**
 * Sends WhitespaceTradesUpKeep.performUpkeep(abi.encode(SimplifiedTradeId[], timestamp)) through the
 * shared @whitespace/txsender queue — one nonce queue per forwarder key, receipt timeouts
 * with same-nonce replacement, reverts that advance the nonce, and a JSON Lines dead letter.
 *
 * This file only turns a batch of triggers into calldata. Reverts are NOT retried: an automation
 * trigger that reverted did so deterministically (the trade is gone, a trigger is pending), and
 * the engine's cooldown and next sweep re-decide from fresh chain state instead.
 *
 * Every trigger expires. The timestamp in performData becomes the order's request timestamp,
 * and WhitespacePriceUpKeep refuses the keeper's report with StaleReport once
 * block.timestamp > timestamp + maxAge (10 s). A trigger mined after that still parks the
 * trade behind TriggerPending for triggerTimeout blocks and is never filled. Hence:
 *  - `deadlineMs` on a send: nothing is broadcast or retried after it, and an expired send is
 *    reported `expired`, never dead-lettered (re-sending it later could only be wasted);
 *  - pipeline mode, so a batch does not wait for the previous batch's receipt to go out;
 *  - a receipt timeout of seconds, not the shared default of 30 s: one stuck transaction used
 *    to hold the queue for up to (maxBumps + 1) x 30 s x (maxRetries + 1) ≈ 8 minutes.
 */

import { encodeFunctionData } from 'viem';
import { createTxSender as createSharedTxSender } from '@whitespace/txsender';
import { TRADES_UPKEEP_ABI } from './abi.mjs';
import { encodePerformData } from './performData.mjs';

/** About two 1 s blocks of slack over a normal inclusion; past that, replace the tx. */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 4_000;
/** Same-nonce replacements per attempt. The shared sender does not stop bumping at the
 * deadline, so keep that worst case short: (2 + 1) x 4 s. Not 0: a stuck nonce has to be
 * unstuck, every later send waits behind it. */
export const DEFAULT_MAX_GAS_BUMPS = 2;

/**
 * @param {object} opts every option of @whitespace/txsender's createTxSender, plus:
 * @param {`0x${string}`} opts.tradesUpKeepAddress
 */
export function createTxSender({ tradesUpKeepAddress, metricsPrefix = 'liquidator_tx', ...senderOpts }) {
  if (!tradesUpKeepAddress) throw new Error('createTxSender: tradesUpKeepAddress is required');
  const sender = createSharedTxSender({
    metricsPrefix,
    retryOnRevert: false,
    pipeline: true,
    // Same reason as the keeper: a pipelined batch is estimated before the ones ahead of it
    // have mined, and an exact estimate then runs out of gas.
    gasHeadroomPercent: 30,
    receiptTimeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS,
    maxBumps: DEFAULT_MAX_GAS_BUMPS,
    ...senderOpts,
  });

  /**
   * Resolves {ok, hash} or {ok:false, reason, reverted, expired, attempts}; never throws for a send failure.
   * @param {{ trades: { trader: `0x${string}`, pairIndex: number, index: number, limitOrder: number }[], timestamp: number, deadlineMs?: number }} payload
   */
  async function sendPerformUpkeep({ trades, timestamp, deadlineMs }) {
    const data = encodeFunctionData({
      abi: TRADES_UPKEEP_ABI,
      functionName: 'performUpkeep',
      args: [encodePerformData(trades, timestamp)],
    });
    const key = trades.map((t) => `${t.trader}-${t.pairIndex}-${t.index}-${t.limitOrder}`).join('|');
    const result = await sender.send({
      to: tradesUpKeepAddress,
      data,
      key,
      meta: {
        timestamp,
        trades: trades.map(({ trader, pairIndex, index, limitOrder }) => ({ trader, pairIndex, index, limitOrder })),
      },
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    });
    if (result.ok) return { ok: true, hash: result.hash };
    return {
      ok: false,
      reason: result.reason ?? 'unknown',
      hash: result.hash,
      reverted: result.reverted === true,
      expired: result.expired === true,
      // 0 with `expired`: the deadline passed while the send was still queued, so nothing
      // reached the chain and the trigger can be re-decided at once.
      attempts: result.attempts ?? 0,
    };
  }

  return {
    sendPerformUpkeep,
    sender,
    retryDeadLetters: (opts) => sender.retryDeadLetters(opts),
    get nonce() {
      return sender.nonce;
    },
  };
}
