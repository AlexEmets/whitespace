/**
 * Watches PriceRequestedV2 on the price upkeep contract. `toPriceRequestedEvent` is
 * the pure part (log in, domain event out) and is unit-tested directly with a
 * synthetic log; `watchPriceRequested` is the RPC subscription wrapper around it and
 * is exercised only by the live entrypoint.
 *
 * The timestamp is read verbatim from `log.args.timestamp` — this file must never
 * substitute Date.now() or block.timestamp for it. A mismatch against the timestamp
 * recorded on-chain when the order was placed reverts InvalidPrice(orderId), which is
 * the entire point of the two-phase flow (design spec §5.1).
 */

import { orderTypeName } from '@whitespace/shared/orderTypes';
import { PRICE_UPKEEP_ABI } from './abi.mjs';

/**
 * @param {{ args: { orderId: bigint, orderType: number, feed: `0x${string}`, timestamp: bigint }, blockNumber?: bigint, transactionHash?: `0x${string}` }} log
 */
export function toPriceRequestedEvent(log) {
  const { orderId, orderType, feed, timestamp } = log.args;
  return {
    orderId,
    orderType: Number(orderType),
    orderTypeName: orderTypeName(orderType),
    feed,
    timestamp: Number(timestamp),
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

/**
 * @param {import('viem').PublicClient} publicClient
 * @param {`0x${string}`} priceUpKeepAddress
 * @param {(event: ReturnType<typeof toPriceRequestedEvent>) => void} onEvent
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} unwatch
 */
export function watchPriceRequested(publicClient, priceUpKeepAddress, onEvent, onError = () => {}) {
  return publicClient.watchContractEvent({
    address: priceUpKeepAddress,
    abi: PRICE_UPKEEP_ABI,
    eventName: 'PriceRequestedV2',
    onLogs: (logs) => {
      for (const log of logs) {
        try {
          onEvent(toPriceRequestedEvent(log));
        } catch (err) {
          onError(err);
        }
      }
    },
    onError,
  });
}
