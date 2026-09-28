/**
 * Sends OstiumTradesUpKeep.performUpkeep(abi.encode(SimplifiedTradeId[], timestamp)) through the
 * shared @whitespace/txsender queue — one serial nonce queue per forwarder key, receipt timeouts
 * with same-nonce replacement, reverts that advance the nonce, and a JSON Lines dead letter.
 *
 * This file only turns a batch of triggers into calldata. Reverts are NOT retried: an automation
 * trigger that reverted did so deterministically (the trade is gone, a trigger is pending), and
 * the engine's cooldown and next sweep re-decide from fresh chain state instead.
 */

import { encodeFunctionData } from 'viem';
import { createTxSender as createSharedTxSender } from '@whitespace/txsender';
import { TRADES_UPKEEP_ABI } from './abi.mjs';
import { encodePerformData } from './performData.mjs';

/**
 * @param {object} opts every option of @whitespace/txsender's createTxSender, plus:
 * @param {`0x${string}`} opts.tradesUpKeepAddress
 */
export function createTxSender({ tradesUpKeepAddress, metricsPrefix = 'liquidator_tx', ...senderOpts }) {
  if (!tradesUpKeepAddress) throw new Error('createTxSender: tradesUpKeepAddress is required');
  const sender = createSharedTxSender({ metricsPrefix, retryOnRevert: false, ...senderOpts });

  /**
   * Resolves {ok, hash} or {ok:false, reason}; never throws for a send failure.
   * @param {{ trades: { trader: `0x${string}`, pairIndex: number, index: number, limitOrder: number }[], timestamp: number }} payload
   */
  async function sendPerformUpkeep({ trades, timestamp }) {
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
    });
    return result.ok ? { ok: true, hash: result.hash } : { ok: false, reason: result.reason ?? 'unknown', hash: result.hash };
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
