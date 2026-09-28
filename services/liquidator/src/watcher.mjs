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
 * @param {import('viem').PublicClient} publicClient
 * @param {{ observe: (sample: { nowMs: number, blockNumber: bigint }) => void }} sequencerMonitor
 * @param {ReturnType<typeof import('./positionTable.mjs').createPositionTable>} positionTable
 * @param {number} intervalMs
 * @returns {() => void} stop
 */
export function watchLiveness(publicClient, sequencerMonitor, positionTable, intervalMs = 2_000) {
  let highestSeen = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const blockNumber = await publicClient.getBlockNumber();
      if (highestSeen !== null && blockNumber < highestSeen) {
        positionTable.pruneFromBlock(blockNumber);
      }
      if (highestSeen === null || blockNumber > highestSeen) highestSeen = blockNumber;
      sequencerMonitor.observe({ nowMs: Date.now(), blockNumber });
    } catch {
      // The fallback transport (rpc.mjs) has already tried every endpoint. A failure
      // here is "no new block observed": the monitor's gap clock keeps running, so a
      // total RPC outage reaches STALLED instead of freezing the last known state.
      sequencerMonitor.observeFailure({ nowMs: Date.now() });
    }
    if (!stopped) setTimeout(tick, intervalMs);
  }

  tick();
  return () => {
    stopped = true;
  };
}
