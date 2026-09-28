/**
 * Watches OstiumTradingCallbacks for MarketOpenExecuted / LimitOpenExecuted — the
 * candidate-discovery input to services/liquidator/src/positionTable.mjs. See
 * positionTable.mjs's file header for why open events are sufficient (no tradeId
 * correlation with close events needed; every margin decision re-reads live state keyed
 * by (trader, pairIndex, index)).
 *
 * `toOpenEvent` is the pure part (log in, candidate event out) and is unit-tested
 * directly with a synthetic log, mirroring services/keeper/src/watcher.mjs's split
 * between a pure decoder and a thin live-subscription wrapper.
 */

import { CALLBACKS_ABI } from './abi.mjs';

/**
 * @param {{ args: { orderId: bigint, t: { trader: `0x${string}`, pairIndex: number, index: number } }, blockNumber?: bigint }} log
 */
export function toOpenEvent(log) {
  const { t } = log.args;
  return {
    trader: t.trader,
    pairIndex: Number(t.pairIndex),
    index: Number(t.index),
    blockNumber: log.blockNumber ?? 0n,
  };
}

/**
 * @param {import('viem').PublicClient} publicClient
 * @param {`0x${string}`} callbacksAddress
 * @param {(event: ReturnType<typeof toOpenEvent>) => void} onOpen
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} unwatch (unsubscribes both event watchers)
 */
export function watchOpenEvents(publicClient, callbacksAddress, onOpen, onError = () => {}) {
  const handleLogs = (logs) => {
    for (const log of logs) {
      try {
        onOpen(toOpenEvent(log));
      } catch (err) {
        onError(err);
      }
    }
  };

  const unwatchMarket = publicClient.watchContractEvent({
    address: callbacksAddress,
    abi: CALLBACKS_ABI,
    eventName: 'MarketOpenExecuted',
    onLogs: handleLogs,
    onError,
  });
  const unwatchLimit = publicClient.watchContractEvent({
    address: callbacksAddress,
    abi: CALLBACKS_ABI,
    eventName: 'LimitOpenExecuted',
    onLogs: handleLogs,
    onError,
  });

  return () => {
    unwatchMarket();
    unwatchLimit();
  };
}

/**
 * Polls the current block number on an interval, feeding both the sequencer-liveness
 * monitor (design spec §6.5) and a reorg detector (design spec §7 "chain reorg ->
 * position table must not act on orphaned state") from the same signal. A reorg is
 * detected the simple, conservative way: if the reported head block number goes
 * backward relative to the highest one already seen, everything discovered at or after
 * the new (lower) head is pruned from the position table — see positionTable.mjs's
 * pruneFromBlock. This will not catch every reorg shape (e.g. a same-height
 * reorganization that doesn't move the number backward), which is exactly why
 * chainReader.readTrade always re-reads live state before any decision instead of
 * trusting the table alone (see docs/decisions/phase-6-liquidator.md).
 *
 * Every configured endpoint is probed individually each tick, so each one's health is
 * reported on its own (`liquidator_rpc_healthy{endpoint=...}`) instead of being hidden
 * behind the fallback transport. The head used for liveness is the highest block any
 * endpoint returned.
 *
 * @param {object} opts
 * @param {{ url: string, getBlockNumber: () => Promise<bigint> }[]} opts.endpoints
 * @param {{ observe: Function, observeFailure: Function }} opts.sequencerMonitor
 * @param {number} [opts.intervalMs]
 * @param {(url: string, ok: boolean) => void} [opts.onEndpointResult]
 * @param {(blockNumber: bigint) => void} [opts.onReorg] head moved backward to `blockNumber`
 * @returns {() => void} stop
 */
export function watchLiveness({ endpoints, sequencerMonitor, intervalMs = 2_000, onEndpointResult = () => {}, onReorg = () => {} }) {
  if (!endpoints?.length) throw new Error('watchLiveness: at least one endpoint is required');
  let highestSeen = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const results = await Promise.allSettled(endpoints.map((e) => e.getBlockNumber()));
    let head = null;
    results.forEach((r, i) => {
      onEndpointResult(endpoints[i].url, r.status === 'fulfilled');
      if (r.status === 'fulfilled' && (head === null || r.value > head)) head = r.value;
    });
    if (head === null) {
      // Every endpoint failed. That is "no new block observed": the monitor's gap clock
      // keeps running, so a total RPC outage reaches STALLED instead of freezing the
      // last known state.
      sequencerMonitor.observeFailure({ nowMs: Date.now() });
    } else {
      if (highestSeen !== null && head < highestSeen) onReorg(head);
      if (highestSeen === null || head > highestSeen) highestSeen = head;
      sequencerMonitor.observe({ nowMs: Date.now(), blockNumber: head });
    }
    if (!stopped) setTimeout(tick, intervalMs);
  }

  tick();
  return () => {
    stopped = true;
  };
}
