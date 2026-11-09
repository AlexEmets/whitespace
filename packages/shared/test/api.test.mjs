import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_ENDPOINTS, API_GROUPS, WS_CHANNELS, publicEndpoints } from '../src/api.mjs';

test('every endpoint belongs to a group the reference has a section for', () => {
  const groups = new Set(API_GROUPS.map((g) => g.id));
  for (const e of API_ENDPOINTS) assert.ok(groups.has(e.group), `${e.path} -> ${e.group}`);
});

test('no route is described twice', () => {
  const keys = API_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(WS_CHANNELS.map((c) => c.kind)).size, WS_CHANNELS.length);
});

test('every public endpoint has a GET to try, and every path parameter is documented', () => {
  for (const e of publicEndpoints()) {
    assert.equal(e.method, 'GET', e.path);
    assert.ok(e.example?.startsWith('/'), e.path);
    const named = [...e.path.matchAll(/:([^/]+)/g)].map((m) => m[1]);
    assert.deepEqual(
      e.params.filter((p) => p.in === 'path').map((p) => p.name),
      named,
      e.path,
    );
  }
});

test('the public list is everything but the internal routes', () => {
  assert.deepEqual(
    API_ENDPOINTS.filter((e) => e.internal).map((e) => `${e.method} ${e.path}`),
    ['POST /faucet/wbt'],
  );
  assert.equal(publicEndpoints().length, API_ENDPOINTS.length - 1);
});
