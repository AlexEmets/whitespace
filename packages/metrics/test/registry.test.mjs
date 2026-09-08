import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/registry.mjs';

test('counter starts at zero and accumulates', () => {
  const reg = createRegistry();
  const c = reg.counter('liquidations_attempted_total', 'Liquidation triggers submitted');
  assert.equal(c.value(), 0);
  c.inc();
  c.inc(2);
  assert.equal(c.value(), 3);
});

test('counter rejects negative increments (counters only go up)', () => {
  const reg = createRegistry();
  const c = reg.counter('x', 'x');
  assert.throws(() => c.inc(-1));
});

test('gauge can be set, incremented and decremented, including negative values', () => {
  const reg = createRegistry();
  const g = reg.gauge('positions_below_maintenance', 'Positions currently below maintenance margin');
  g.set(5);
  assert.equal(g.value(), 5);
  g.dec(2);
  assert.equal(g.value(), 3);
  g.inc(10);
  assert.equal(g.value(), 13);
});

test('metrics are label-scoped: different label sets do not collide', () => {
  const reg = createRegistry();
  const rpc = reg.gauge('rpc_healthy', 'RPC endpoint health (1=up, 0=down)');
  rpc.set(1, { endpoint: 'a' });
  rpc.set(0, { endpoint: 'b' });
  assert.equal(rpc.value({ endpoint: 'a' }), 1);
  assert.equal(rpc.value({ endpoint: 'b' }), 0);
});

test('render() produces Prometheus text exposition format with HELP/TYPE and label syntax', () => {
  const reg = createRegistry();
  const c = reg.counter('liquidations_won_total', 'Liquidations this instance executed first');
  c.inc(3);
  const g = reg.gauge('sequencer_state', 'Sequencer liveness state (0=LIVE,1=STALLED,2=RECOVERING)');
  g.set(1, { chain: '1874' });

  const text = reg.render();

  assert.match(text, /# HELP liquidations_won_total Liquidations this instance executed first/);
  assert.match(text, /# TYPE liquidations_won_total counter/);
  assert.match(text, /^liquidations_won_total 3$/m);
  assert.match(text, /# TYPE sequencer_state gauge/);
  assert.match(text, /^sequencer_state\{chain="1874"\} 1$/m);
});

test('render() still emits HELP/TYPE for a metric with no observed series', () => {
  const reg = createRegistry();
  reg.counter('dead_letter_depth', 'Entries in the liquidator dead-letter queue');
  const text = reg.render();
  assert.match(text, /# HELP dead_letter_depth/);
  assert.match(text, /# TYPE dead_letter_depth counter/);
});
