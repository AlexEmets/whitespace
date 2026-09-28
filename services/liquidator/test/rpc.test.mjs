import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointLabel, createEndpointProbes } from '../src/rpc.mjs';

test('endpointLabel keeps scheme and host and drops a path/query API key', () => {
  assert.equal(endpointLabel('https://rpc.example.com/v2/SECRETKEY?x=1'), 'https://rpc.example.com');
  assert.equal(endpointLabel('http://127.0.0.1:4000/main/evm/1874'), 'http://127.0.0.1:4000');
});

test('endpointLabel does not throw on garbage', () => {
  assert.equal(endpointLabel('not a url'), 'invalid-url');
});

test('createEndpointProbes returns one probe per url, in order', () => {
  const probes = createEndpointProbes(['http://127.0.0.1:1', 'http://127.0.0.1:2']);
  assert.deepEqual(
    probes.map((p) => p.url),
    ['http://127.0.0.1:1', 'http://127.0.0.1:2'],
  );
  assert.equal(typeof probes[0].getBlockNumber, 'function');
});
