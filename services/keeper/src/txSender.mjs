/**
 * Delivers performUpkeep(performData) to the price upkeep through the shared
 * @whitespace/txsender queue. Everything about nonces, gas, receipt timeouts,
 * replacements, retries and dead letters lives there; this file only turns an order
 * into calldata and gives the dead letter the orderId an operator will search for.
 *
 * The sender used to be local to this service and got three things wrong: concurrent
 * orders read the same cached nonce, a mined revert did not advance it, and the
 * receipt wait had no timeout at all.
 */

import { encodeFunctionData } from 'viem';
import { createTxSender as createSharedTxSender } from '@whitespace/txsender';
import { PRICE_UPKEEP_ABI } from './abi.mjs';

/**
 * @param {object} opts every option of @whitespace/txsender's createTxSender, plus:
 * @param {`0x${string}`} opts.priceUpKeepAddress
 */
export function createTxSender({ priceUpKeepAddress, metricsPrefix = 'keeper', ...senderOpts }) {
  if (!priceUpKeepAddress) throw new Error('createTxSender: priceUpKeepAddress is required');
  const sender = createSharedTxSender({ metricsPrefix, ...senderOpts });

  /** @param {{ orderId: bigint, performData: `0x${string}` }} args */
  function send({ orderId, performData }) {
    const data = encodeFunctionData({ abi: PRICE_UPKEEP_ABI, functionName: 'performUpkeep', args: [performData] });
    return sender.send({ to: priceUpKeepAddress, data, key: `order-${orderId}`, meta: { orderId: String(orderId) } });
  }

  return {
    send,
    sender,
    retryDeadLetters: (opts) => sender.retryDeadLetters(opts),
    get nonce() {
      return sender.nonce;
    },
  };
}
