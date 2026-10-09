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

// Our own RPC failures are not evidence about the sequencer. They used to count as "no new
// block", so a short outage on our side suppressed every liquidation for the recovery window.
test('observeFailure never stalls, however long our RPC is unreachable', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  mon.observe({ nowMs: 0, blockNumber: 1000n, blockTimestamp: 0 });
  for (let t = 1_000; t <= 10 * STALL_MS; t += 1_000) mon.observeFailure({ nowMs: t });
  assert.equal(mon.state, SequencerState.LIVE);
  assert.equal(mon.canLiquidate(), true);
});

test('observeFailure with no block ever seen does not stall either', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  for (let t = 0; t <= 2 * STALL_MS; t += 1_000) mon.observeFailure({ nowMs: t });
  assert.equal(mon.state, SequencerState.LIVE);
});

test('an RPC outage while the chain kept producing blocks resumes LIVE, with no recovery window', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  mon.observe({ nowMs: 0, blockNumber: 1000n, blockTimestamp: 0 });
  for (let t = 1_000; t < 40_000; t += 1_000) mon.observeFailure({ nowMs: t });
  // 40 blocks in 40 s: the sequencer never stopped.
  assert.equal(mon.observe({ nowMs: 40_000, blockNumber: 1040n, blockTimestamp: 40 }), SequencerState.LIVE);
  // Without block timestamps the poll gap is not taken as a stall either.
  const bare = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  bare.observe({ nowMs: 0, blockNumber: 1000n });
  bare.observeFailure({ nowMs: 39_000 });
  assert.equal(bare.observe({ nowMs: 40_000, blockNumber: 1040n }), SequencerState.LIVE);
});

test('a head whose own timestamp is >= the threshold old is a stall, even on the first sample', () => {
  const nowMs = 1_000_000;
  const fresh = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  fresh.observe({ nowMs, blockNumber: 1000n, blockTimestamp: (nowMs - STALL_MS + 1_000) / 1000 });
  assert.equal(fresh.state, SequencerState.LIVE, 'one second short of the threshold');

  const old = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  old.observe({ nowMs, blockNumber: 1000n, blockTimestamp: (nowMs - STALL_MS) / 1000 });
  assert.equal(old.state, SequencerState.STALLED);
});

test('a gap between two heads\' timestamps is a stall we did not watch: the window still applies', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  mon.observe({ nowMs: 0, blockNumber: 1000n, blockTimestamp: 0 });
  // Polled 31 s later (our poll was delayed), the very next block is 31 s after the last.
  mon.observe({ nowMs: 31_000, blockNumber: 1001n, blockTimestamp: 31 });
  assert.equal(mon.state, SequencerState.RECOVERING);
  assert.equal(mon.canLiquidate(), false);

  // One block 29 s after the previous one is jitter, not a stall.
  const ok = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  ok.observe({ nowMs: 0, blockNumber: 1000n, blockTimestamp: 0 });
  assert.equal(ok.observe({ nowMs: 29_000, blockNumber: 1001n, blockTimestamp: 29 }), SequencerState.LIVE);

  // Ten blocks over 45 s: nine of them account for 9 s at most, so >= 36 s were a stall.
  const some = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  some.observe({ nowMs: 0, blockNumber: 1000n, blockTimestamp: 0 });
  assert.equal(some.observe({ nowMs: 45_000, blockNumber: 1010n, blockTimestamp: 45 }), SequencerState.RECOVERING);
});

test('the default recovery window is minutes, not an hour', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS });
  mon.observe({ nowMs: 0, blockNumber: 1000n, blockTimestamp: 0 });
  mon.observe({ nowMs: STALL_MS, blockNumber: 1000n, blockTimestamp: 0 });
  assert.equal(mon.state, SequencerState.STALLED);
  const resumedAt = STALL_MS + 1_000;
  mon.observe({ nowMs: resumedAt, blockNumber: 1001n, blockTimestamp: resumedAt / 1000 });
  // One block a second from there on.
  mon.observe({ nowMs: resumedAt + 5 * 60_000 - 1, blockNumber: 1001n + 299n, blockTimestamp: (resumedAt + 5 * 60_000 - 1_000) / 1000 });
  assert.equal(mon.state, SequencerState.RECOVERING);
  mon.observe({ nowMs: resumedAt + 5 * 60_000, blockNumber: 1001n + 300n, blockTimestamp: (resumedAt + 5 * 60_000) / 1000 });
  assert.equal(mon.state, SequencerState.LIVE);
});

test('failures interleaved with advancing blocks never stall (a flaky endpoint is not an outage)', () => {
  const mon = createSequencerMonitor({ stallThresholdMs: STALL_MS, recoveryWindowMs: RECOVERY_MS });
  let block = 1000n;
  for (let t = 0; t <= 4 * STALL_MS; t += 10_000) {
    if ((t / 10_000) % 2 === 0) mon.observe({ nowMs: t, blockNumber: block++ });
    else mon.observeFailure({ nowMs: t });
  }
  assert.equal(mon.state, SequencerState.LIVE);
});
