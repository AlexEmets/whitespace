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
 * fallback block producer), so a gap in BLOCK TIMESTAMPS longer than a stall threshold
 * is a reasonable, self-contained proxy for "the sequencer is down" — see
 * docs/decisions/phase-6-liquidator.md for the honest caveats on this proxy.
 *
 * Only the chain's own clock is evidence. A stall is either
 *   - a head that an endpoint DID return, whose timestamp is >= stallThresholdMs old, or
 *   - two heads whose timestamps are further apart than the blocks between them account
 *     for by >= stallThresholdMs (a stall we could not watch live, e.g. while our own RPC
 *     was unreachable).
 * Our own failure to reach an RPC endpoint is not evidence of anything about the
 * sequencer. It used to count as "no new block", so a few seconds of RPC trouble on our
 * side became a STALLED -> RECOVERING cycle that suppressed every liquidation on the
 * chain for an hour while the sequencer never missed a block.
 *
 * Pure state machine: callers feed it `{ nowMs, blockNumber, blockTimestamp }` samples and
 * read back whether liquidation is currently allowed. No timers, no RPC calls in this file.
 *
 * States:
 *   LIVE        — blocks are arriving within the stall threshold; liquidations allowed.
 *   STALLED     — the head is >= stallThresholdMs old; liquidations blocked.
 *   RECOVERING  — blocks resumed after a stall, but the recovery window has not yet
 *                 elapsed; liquidations still blocked. A renewed stall during this window
 *                 sends the state back to STALLED and restarts the window from scratch on
 *                 the next recovery — a flapping sequencer never accumulates partial
 *                 credit toward the window.
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

/** 1874's block time (design spec §2.1). */
export const BLOCK_TIME_MS = 1_000;

/** How long after blocks resume before liquidations resume. The window exists so a
 * trader can react (add margin, close) to a move that happened while they could not
 * transact; a few minutes is enough for that. It used to be 1 h, after Aave's Arbitrum
 * `GRACE_PERIOD_TIME = 3600` — but there that hour protects against a stall of the whole
 * L2, while every liquidation it holds back here is bad debt growing for the pool.
 * Configurable (LIQUIDATOR_SEQUENCER_RECOVERY_WINDOW_MS). */
export const SEQUENCER_RECOVERY_WINDOW_MS = 5 * 60 * 1000;

/**
 * @param {object} [opts]
 * @param {number} [opts.stallThresholdMs]
 * @param {number} [opts.recoveryWindowMs]
 * @param {number} [opts.blockTimeMs] the chain's block time, the least two blocks are apart
 */
export function createSequencerMonitor({
  stallThresholdMs = SEQUENCER_STALL_THRESHOLD_MS,
  recoveryWindowMs = SEQUENCER_RECOVERY_WINDOW_MS,
  blockTimeMs = BLOCK_TIME_MS,
} = {}) {
  let state = SequencerState.LIVE;
  let lastBlockNumber = null;
  /** The last head's own timestamp in ms (or, without one, when we first saw it). */
  let lastBlockAtMs = null;
  let lastHadTimestamp = false;
  let recoveryStartedAtMs = null;

  function enterRecovery(nowMs) {
    state = SequencerState.RECOVERING;
    recoveryStartedAtMs = nowMs;
  }

  /**
   * Feed one liveness sample: the head an RPC endpoint returned. Call this on every poll
   * tick, whether or not the head moved, so a stall is detected while it lasts.
   *
   * @param {object} sample
   * @param {number} sample.nowMs wall-clock time of this observation
   * @param {bigint|number} sample.blockNumber the latest L2 block number observed
   * @param {bigint|number} [sample.blockTimestamp] that block's timestamp, in seconds.
   *        Without it the time the block was first seen stands in for it.
   * @returns {typeof SequencerState[keyof typeof SequencerState]}
   */
  function observe({ nowMs, blockNumber, blockTimestamp }) {
    const hasTimestamp = blockTimestamp !== undefined && blockTimestamp !== null;
    const blockAtMs = hasTimestamp ? Number(blockTimestamp) * 1000 : nowMs;
    if (lastBlockNumber === null) {
      lastBlockNumber = blockNumber;
      lastBlockAtMs = blockAtMs;
      lastHadTimestamp = hasTimestamp;
      // The first head we ever see can already be old: a stall that began before we started.
      checkHeadAge(nowMs);
    } else if (blockNumber > lastBlockNumber) {
      // Blocks are being produced. Resuming from a stall we watched, or a gap between two
      // heads that is itself a stall we did not get to watch, both start the window.
      // The heads we see need not be consecutive blocks (a slow poll, our RPC down for a
      // while), so the gap is the time the blocks in between cannot account for: each one
      // takes at least blockTimeMs. Without timestamps on both heads the gap would be one
      // between OUR observations, which an outage on our side stretches just as well, so
      // it is not used at all.
      const blocksBetween = Number(BigInt(blockNumber) - BigInt(lastBlockNumber)) - 1;
      const chainGapMs = hasTimestamp && lastHadTimestamp ? blockAtMs - lastBlockAtMs - blocksBetween * blockTimeMs : 0;
      if (state === SequencerState.STALLED || chainGapMs >= stallThresholdMs) enterRecovery(nowMs);
      lastBlockNumber = blockNumber;
      lastBlockAtMs = blockAtMs;
      lastHadTimestamp = hasTimestamp;
    } else if (blockNumber < lastBlockNumber) {
      // A block number that went backward is a reorg signal, not a liveness signal on
      // its own; the per-candidate live re-read before any trigger (automationEngine.mjs) is
      // responsible for not acting on orphaned state. This module only tracks whether
      // *some* block is arriving, so it neither advances nor stalls on this sample.
    } else {
      checkHeadAge(nowMs);
    }

    return finishRecovery(nowMs);
  }

  function checkHeadAge(nowMs) {
    if (nowMs - lastBlockAtMs >= stallThresholdMs && state !== SequencerState.STALLED) {
      // From LIVE, or stalled again mid-recovery: the window restarts from scratch once
      // blocks resume again.
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
   * A poll on which every RPC endpoint failed. That says nothing about the sequencer — only
   * about our own connectivity — so it changes nothing: not the state, not the gap clock,
   * not the recovery window. If the sequencer did stall meanwhile, the next head we do get
   * shows it (its timestamp is old, or far after the previous head's).
   *
   * @param {{ nowMs: number }} _sample
   */
  function observeFailure(_sample) {
    return state;
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
