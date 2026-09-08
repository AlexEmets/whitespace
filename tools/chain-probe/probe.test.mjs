import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbe } from './probe.mjs';
import { CHAINS } from '../../packages/shared/src/chains.mjs';

test('reports no drift when observations match expectations', () => {
  const observed = { eip1559: false, cancun: false, create2Factory: false, multicall3: true };
  assert.deepEqual(classifyProbe(observed, CHAINS[1875].expects), []);
});

test('reports drift when mainnet gains Cancun', () => {
  const observed = { eip1559: false, cancun: true, create2Factory: false, multicall3: true };
  assert.deepEqual(classifyProbe(observed, CHAINS[1875].expects), [
    'cancun: expected false, observed true',
  ]);
});

test('reports every drifted field', () => {
  const observed = { eip1559: true, cancun: true, create2Factory: false, multicall3: true };
  assert.deepEqual(classifyProbe(observed, CHAINS[2625].expects), [
    'eip1559: expected false, observed true',
    'cancun: expected false, observed true',
    'multicall3: expected false, observed true',
  ]);
});

test('chain registry covers exactly the three known networks', () => {
  assert.deepEqual(Object.keys(CHAINS).sort(), ['1874', '1875', '2625']);
});
