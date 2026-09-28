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
 * Largest block span this watcher will ask for in one `eth_getLogs`.
 *
 * Whitechain's public RPC rejects anything above 10,000 with "query exceeds max block
 * range 10000". This used to be viem's `watchContractEvent`, which holds its own
 * `fromBlock` cursor and does NOT advance it when a poll fails — so once a single query
 * was refused, every subsequent poll asked for a strictly wider range and was refused
 * again. The window grew without bound and the keeper went permanently blind: it was last
 * seen asking for 42,001 blocks at once, having filled nothing since the block it got
 * stuck on.
 *
 * A blind keeper is a broken product, not a degraded one. `openTrade` takes the trader's
 * collateral and emits a price request; if no report is ever delivered, the order sits
 * pending and the collateral stays locked. Observed exactly that: an order requested,
 * 50 USDW taken, no position, no cancellation.
 *
 * 9,000 rather than 10,000 leaves headroom for a node whose limit is inclusive or
 * off-by-one, which is cheap insurance against re-entering a failure mode this expensive.
 */
const MAX_BLOCK_RANGE = 9_000;

/** Orders handled at once within one window. Sends still serialise in the tx queue;
 * this bounds how many report fetches (each of which may retry until its deadline) run
 * side by side, so one slow order cannot hold up the rest of its window. */
export const DEFAULT_CONCURRENCY = 4;

const PRICE_REQUESTED_EVENT = PRICE_UPKEEP_ABI.find(
  (entry) => entry.type === 'event' && entry.name === 'PriceRequestedV2',
);

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
 * Runs `fn` over `items` with at most `limit` in flight, resolving when all are done.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 */
async function forEachBounded(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * @param {import('viem').PublicClient} publicClient
 * @param {`0x${string}`} priceUpKeepAddress
 * @param {(event: ReturnType<typeof toPriceRequestedEvent>) => void|Promise<void>} onEvent
 *   awaited: the watcher does not read the next window until every order in this one
 *   has been handled (or has failed, which goes to `onError`)
 * @param {(err: Error) => void} [onError]
 * @param {{ pollIntervalMs?: number, maxBlockRange?: number, maxChunksPerTick?: number, concurrency?: number }} [opts]
 * @returns {() => void} unwatch
 */
export function watchPriceRequested(publicClient, priceUpKeepAddress, onEvent, onError = () => {}, opts = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? 1_500;
  const maxRange = BigInt(opts.maxBlockRange ?? MAX_BLOCK_RANGE);
  const maxChunksPerTick = opts.maxChunksPerTick ?? 20;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`watchPriceRequested: concurrency must be a positive integer, got ${concurrency}`);
  }

  let stopped = false;
  /** Next block to scan. Null until the first tick establishes the head. */
  let cursor = null;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const head = await publicClient.getBlockNumber();
      // First tick: start at the head. Only orders placed from now on are this process's
      // to fill; anything older belongs to whichever keeper was watching at the time.
      if (cursor === null) cursor = head + 1n;

      let chunks = 0;
      while (!stopped && cursor <= head && chunks < maxChunksPerTick) {
        const to = cursor + maxRange - 1n < head ? cursor + maxRange - 1n : head;
        const logs = await publicClient.getLogs({
          address: priceUpKeepAddress,
          event: PRICE_REQUESTED_EVENT,
          fromBlock: cursor,
          toBlock: to,
        });
        await forEachBounded(logs, concurrency, async (log) => {
          try {
            await onEvent(toPriceRequestedEvent(log));
          } catch (err) {
            onError(err);
          }
        });
        // Advance only after the window has been read AND every order in it handled, so
        // a failure re-reads the same window instead of skipping orders.
        cursor = to + 1n;
        chunks += 1;
      }
    } catch (err) {
      // Cursor deliberately untouched: the next tick retries the same bounded window.
      onError(err);
    } finally {
      running = false;
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), pollIntervalMs);

  return function unwatch() {
    stopped = true;
    clearInterval(timer);
  };
}
