import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSequencerMonitor, SequencerState } from '../src/sequencerLiveness.mjs';

const STALL_MS = 30_000;
const RECOVERY_MS = 60 * 60 * 1000;

test('starts LIVE and stays LIVE while blocks keep arriving within the stall threshold', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  let t = 0;
  let block = 1000n;
  for (let i = 0; i < 5; i++) {
    t += 1_000;
    block += 1n;
    mon.observe({ nowMs: t, blockNumber: block });
  }
  assert.equal(mon.state, SequencerState.LIVE);
  assert.equal(mon.canLiquidate(), true);
});

test('goes STALLED when no new block arrives for >= the stall threshold, and blocks liquidation', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  mon.observe({ nowMs: 0, blockNumber: 1000n });
  // No new block for a long time -- same blockNumber, growing gap.
  mon.observe({ nowMs: STALL_MS - 1, blockNumber: 1000n });
  assert.equal(mon.state, SequencerState.LIVE, 'must not stall one ms early');
  mon.observe({ nowMs: STALL_MS, blockNumber: 1000n });
  assert.equal(mon.state, SequencerState.STALLED);
  assert.equal(mon.canLiquidate(), false);
});

test('recovery window BLOCKS liquidation for its full duration after blocks resume', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  mon.observe({ nowMs: 0, blockNumber: 1000n });
  mon.observe({ nowMs: STALL_MS, blockNumber: 1000n });
  assert.equal(mon.state, SequencerState.STALLED);

  // Sequencer resumes: a new block arrives.
  const resumedAt = STALL_MS + 5_000;
  mon.observe({ nowMs: resumedAt, blockNumber: 1001n });
  assert.equal(mon.state, SequencerState.RECOVERING);
  assert.equal(mon.canLiquidate(), false, 'must not liquidate immediately on resumption');

  // Still inside the recovery window, even with more blocks arriving normally.
  mon.observe({ nowMs: resumedAt + RECOVERY_MS - 1, blockNumber: 1002n });
  assert.equal(mon.state, SequencerState.RECOVERING);
  assert.equal(mon.canLiquidate(), false, 'must still be blocked one ms before the window elapses');
});

test('recovery window ALLOWS liquidation once it has fully elapsed', () => {
  // This is the other half of the previous test: a one-directional test (only ever
  // checking "blocked") cannot distinguish a working window from one that blocks
  // liquidation forever. This test proves the gate actually opens.
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  mon.observe({ nowMs: 0, blockNumber: 1000n });
  mon.observe({ nowMs: STALL_MS, blockNumber: 1000n });
  assert.equal(mon.state, SequencerState.STALLED);

  const resumedAt = STALL_MS + 5_000;
  mon.observe({ nowMs: resumedAt, blockNumber: 1001n });
  assert.equal(mon.canLiquidate(), false);

  const state = mon.observe({ nowMs: resumedAt + RECOVERY_MS, blockNumber: 1002n });
  assert.equal(state, SequencerState.LIVE);
  assert.equal(mon.canLiquidate(), true);
});

test('a renewed stall mid-recovery restarts the window from scratch (no partial credit)', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  mon.observe({ nowMs: 0, blockNumber: 1000n });
  mon.observe({ nowMs: STALL_MS, blockNumber: 1000n }); // STALLED
  const resumedAt = STALL_MS + 1_000;
  mon.observe({ nowMs: resumedAt, blockNumber: 1001n }); // RECOVERING
  assert.equal(mon.state, SequencerState.RECOVERING);

  // Nearly through the window, then it stalls again before completing.
  const almostDone = resumedAt + RECOVERY_MS - 1_000;
  mon.observe({ nowMs: almostDone, blockNumber: 1001n }); // no new block -- gap growing
  mon.observe({ nowMs: almostDone + STALL_MS, blockNumber: 1001n }); // gap now >= stall threshold
  assert.equal(mon.state, SequencerState.STALLED, 'must fall back to STALLED, not stay RECOVERING');

  // Resume again: the window must restart, not resume from where it left off.
  const secondResumeAt = almostDone + STALL_MS + 1_000;
  mon.observe({ nowMs: secondResumeAt, blockNumber: 1002n });
  assert.equal(mon.state, SequencerState.RECOVERING);
  // If the window had "continued" from the first recovery attempt, a further 1000ms
  // would already exceed it; it must not, because the window restarted.
  mon.observe({ nowMs: secondResumeAt + 1_000, blockNumber: 1003n });
  assert.equal(mon.canLiquidate(), false);
});

test('a block number moving backward (reorg signal) does not by itself flip LIVE->STALLED or advance liveness', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  mon.observe({ nowMs: 0, blockNumber: 1000n });
  mon.observe({ nowMs: 1_000, blockNumber: 1001n });
  const state = mon.observe({ nowMs: 2_000, blockNumber: 999n }); // reorg to a lower number
  assert.equal(state, SequencerState.LIVE);
});
