/**
 * Sequencer-liveness recovery window (design spec §6.5, §7 "Sequencer stall -> recovery
 * window before liquidations resume").
 *
 * 1874 is an OP Stack rollup with no dedicated sequencer-uptime oracle — unlike
 * Arbitrum, where Chainlink publishes a first-class L2 sequencer-uptime feed
 * (`0xFdB631F5EE196F0ed6FAa767959853A9F217697D` on Arbitrum One) that contracts like
 * Aave's `PriceOracleSentinel` gate on before allowing liquidations. That feed does not
 * exist here (design spec §6.5 says so explicitly), so this module is our own
 * approximation of the same idea, built from the one signal we do have: L2 block
 * production. If the sequencer stalls, no new L2 blocks are produced (1874 has no
 * fallback block producer), so "no new block for longer than a stall threshold" is a
 * reasonable, self-contained proxy for "the sequencer is down" — see
 * docs/decisions/phase-6-liquidator.md for the honest caveats on this proxy.
 *
 * Pure state machine: callers feed it `{ nowMs, blockNumber }` samples (from polling
 * `eth_blockNumber`, or from the block number on each newly observed log) and read back
 * whether liquidation is currently allowed. No timers, no RPC calls in this file.
 *
 * States:
 *   LIVE        — blocks are arriving within the stall threshold; liquidations allowed.
 *   STALLED     — no new block for >= stallThresholdMs; liquidations blocked.
 *   RECOVERING  — a new block just arrived after a stall, but the recovery window has
 *                 not yet elapsed; liquidations still blocked. A renewed stall during
 *                 this window sends the state back to STALLED and restarts the window
 *                 from scratch on the next recovery — a flapping sequencer never
 *                 accumulates partial credit toward the window.
 */

export const SequencerState = Object.freeze({
  LIVE: 'LIVE',
  STALLED: 'STALLED',
  RECOVERING: 'RECOVERING',
});

/** How long without a new block before we call the sequencer stalled. Well above the
 * chain's normal 1.00 s block time (design spec §2.1) to avoid false positives from
 * ordinary jitter, well below anything that would let a real outage go undetected for
 * long. Starting point, not tuned against measured data — a named constant so it is
 * never a magic number at its use site. */
export const SEQUENCER_STALL_THRESHOLD_MS = 30_000; // 30x the normal block time

/** How long after blocks resume before liquidations resume. 1 hour mirrors the grace
 * period convention seen in Aave's Arbitrum sequencer-uptime integration
 * (`GRACE_PERIOD_TIME = 3600` seconds) — a reasonable, documented starting point for a
 * chain with no dedicated uptime oracle of its own, not a value measured against this
 * chain's actual outage behavior (none has been observed). Tune in phase 7 against
 * real incident data if any occurs. */
export const SEQUENCER_RECOVERY_WINDOW_MS = 60 * 60 * 1000;

/**
 * @param {object} [opts]
 * @param {number} [opts.stallThresholdMs]
 * @param {number} [opts.recoveryWindowMs]
 */
export function createSequencerMonitor({
  stallThresholdMs = SEQUENCER_STALL_THRESHOLD_MS,
  recoveryWindowMs = SEQUENCER_RECOVERY_WINDOW_MS,
} = {}) {
  let state = SequencerState.LIVE;
  let lastBlockNumber = null;
  let lastBlockSeenAtMs = null;
  let recoveryStartedAtMs = null;

  /**
   * Feed one liveness sample. Call this on every poll tick (whether or not the block
   * number actually changed) so stalls are detected even between ticks that see no new
   * block, and call it on every newly observed contract log too, so a burst of
   * liquidation-relevant events also counts as liveness evidence.
   *
   * @param {object} sample
   * @param {number} sample.nowMs wall-clock time of this observation
   * @param {bigint|number} sample.blockNumber the latest L2 block number observed
   * @returns {typeof SequencerState[keyof typeof SequencerState]}
   */
  function observe({ nowMs, blockNumber }) {
    if (lastBlockNumber === null) {
      // First block ever. If failures before it already stalled us (a startup outage),
      // this is a resumption like any other and must go through the recovery window.
      if (state === SequencerState.STALLED) {
        state = SequencerState.RECOVERING;
        recoveryStartedAtMs = nowMs;
      }
      lastBlockNumber = blockNumber;
      lastBlockSeenAtMs = nowMs;
    } else if (blockNumber > lastBlockNumber) {
      if (state === SequencerState.STALLED) {
        state = SequencerState.RECOVERING;
        recoveryStartedAtMs = nowMs;
      }
      lastBlockNumber = blockNumber;
      lastBlockSeenAtMs = nowMs;
    } else if (blockNumber < lastBlockNumber) {
      // A block number that went backward is a reorg signal, not a liveness signal on
      // its own; the per-candidate live re-read before any trigger (automationEngine.mjs) is
      // responsible for not acting on orphaned state. This module only tracks whether
      // *some* block is arriving, so it neither advances nor stalls on this sample.
    } else {
      noNewBlock(nowMs);
    }

    return finishRecovery(nowMs);
  }

  function noNewBlock(nowMs) {
    const gapMs = nowMs - lastBlockSeenAtMs;
    if (gapMs >= stallThresholdMs && state === SequencerState.LIVE) {
      state = SequencerState.STALLED;
      recoveryStartedAtMs = null;
    } else if (gapMs >= stallThresholdMs && state === SequencerState.RECOVERING) {
      // Stalled again mid-recovery: back to STALLED, window restarts from scratch
      // once blocks resume again.
      state = SequencerState.STALLED;
      recoveryStartedAtMs = null;
    }
  }

  function finishRecovery(nowMs) {
    if (state === SequencerState.RECOVERING && nowMs - recoveryStartedAtMs >= recoveryWindowMs) {
      state = SequencerState.LIVE;
      recoveryStartedAtMs = null;
    }
    return state;
  }

  /**
   * Feed one FAILED liveness sample (every RPC endpoint errored). We cannot tell a dead
   * sequencer from a dead RPC, and for this service they mean the same thing — nothing
   * we submit can land — so a failure is treated exactly as "no new block": the gap
   * clock keeps running and a long enough outage reaches STALLED. With no block ever
   * seen, the clock starts at the first failure.
   *
   * @param {{ nowMs: number }} sample
   */
  function observeFailure({ nowMs }) {
    if (lastBlockSeenAtMs === null) lastBlockSeenAtMs = nowMs;
    noNewBlock(nowMs);
    return finishRecovery(nowMs);
  }

  return {
    observe,
    observeFailure,
    get state() {
      return state;
    },
    /** @returns {boolean} */
    canLiquidate() {
      return state === SequencerState.LIVE;
    },
  };
}
