import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDegraded, canTrigger } from '../src/degradedMode.mjs';
import { MIN_HEALTHY_VENUES } from '@whitespace/shared/bounds';

test('isDegraded is true below MIN_HEALTHY_VENUES and false at/above it', () => {
  assert.equal(isDegraded(MIN_HEALTHY_VENUES - 1), true);
  assert.equal(isDegraded(MIN_HEALTHY_VENUES), false);
  assert.equal(isDegraded(MIN_HEALTHY_VENUES + 1), false);
  assert.equal(isDegraded(0), true);
});

test('isDegraded honors a caller-supplied per-market minimum', () => {
  assert.equal(isDegraded(3, 4), true);
  assert.equal(isDegraded(2, 2), false);
});

// Every (kind, sequencer state, degraded) combination, including the opt-in to liquidate
// while degraded. `null` = allowed.
const TABLE = [
  // kind    state         degraded  liqWhenDegraded  -> reason
  ['LIQ', 'LIVE', false, false, null],
  ['LIQ', 'LIVE', true, false, 'degraded_liquidations_suppressed'],
  ['LIQ', 'LIVE', true, true, null],
  ['LIQ', 'RECOVERING', false, false, 'sequencer_recovering'],
  ['LIQ', 'RECOVERING', true, true, 'sequencer_recovering'],
  ['LIQ', 'STALLED', false, false, 'sequencer_stalled'],
  ['SL', 'LIVE', false, false, null],
  ['SL', 'LIVE', true, false, null],
  ['SL', 'RECOVERING', true, false, null],
  ['SL', 'STALLED', false, false, 'sequencer_stalled'],
  ['TP', 'LIVE', true, false, null],
  ['TP', 'RECOVERING', false, false, null],
  ['TP', 'STALLED', false, false, 'sequencer_stalled'],
  ['OPEN', 'LIVE', false, false, null],
  ['OPEN', 'LIVE', true, false, 'degraded_opens_blocked'],
  ['OPEN', 'LIVE', true, true, 'degraded_opens_blocked'],
  ['OPEN', 'RECOVERING', false, false, null],
  ['OPEN', 'RECOVERING', true, false, 'degraded_opens_blocked'],
  ['OPEN', 'STALLED', false, false, 'sequencer_stalled'],
];

for (const [kind, sequencerState, degraded, liquidateWhenDegraded, reason] of TABLE) {
  test(`canTrigger ${kind} / ${sequencerState} / degraded=${degraded} / liqWhenDegraded=${liquidateWhenDegraded} -> ${reason ?? 'ok'}`, () => {
    const r = canTrigger({ kind, sequencerState, degraded, liquidateWhenDegraded });
    if (reason === null) assert.deepEqual(r, { ok: true });
    else assert.deepEqual(r, { ok: false, reason });
  });
}

test('canTrigger defaults to NOT liquidating while degraded', () => {
  assert.equal(canTrigger({ kind: 'LIQ', sequencerState: 'LIVE', degraded: true }).ok, false);
});

test('canTrigger rejects an unknown kind', () => {
  assert.throws(() => canTrigger({ kind: 'CLOSE_DAY_TRADE', sequencerState: 'LIVE', degraded: false }), /unknown kind/);
});
