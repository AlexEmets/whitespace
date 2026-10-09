/**
 * Chain liveness polling for the sequencer monitor.
 *
 * Polls the latest block (number and timestamp) on an interval and feeds the
 * sequencer-liveness monitor (design spec §6.5); the monitor judges stalls by the chain's
 * own timestamps. A head that moves backward is reported through `onReorg`
 * for logging; it needs no cleanup, because candidates are re-read from the indexer
 * every sweep and every slot is re-read from chain before a trigger.
 *
 * Every configured endpoint is probed individually each tick, so each one's health is
 * reported on its own (`liquidator_rpc_healthy{endpoint=...}`) instead of being hidden
 * behind the fallback transport. The head used for liveness is the highest block any
 * endpoint returned.
 *
 * @param {object} opts
 * @param {{ url: string, getHead: () => Promise<{ number: bigint, timestamp: bigint }> }[]} opts.endpoints
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
    const results = await Promise.allSettled(endpoints.map((e) => e.getHead()));
    let head = null;
    results.forEach((r, i) => {
      onEndpointResult(endpoints[i].url, r.status === 'fulfilled');
      if (r.status === 'fulfilled' && (head === null || r.value.number > head.number)) head = r.value;
    });
    if (head === null) {
      // Every endpoint failed. That is our connectivity, not the sequencer: the monitor
      // ignores it (see sequencerLiveness.mjs), and per-endpoint health is on /metrics.
      sequencerMonitor.observeFailure({ nowMs: Date.now() });
    } else {
      if (highestSeen !== null && head.number < highestSeen) onReorg(head.number);
      if (highestSeen === null || head.number > highestSeen) highestSeen = head.number;
      sequencerMonitor.observe({ nowMs: Date.now(), blockNumber: head.number, blockTimestamp: head.timestamp });
    }
    if (!stopped) setTimeout(tick, intervalMs);
  }

  tick();
  return () => {
    stopped = true;
  };
}
