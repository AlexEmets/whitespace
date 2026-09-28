import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_LOOKBACK_BLOCKS, loadConfig } from '../src/config.mjs';

const BASE = { KEEPER_PRICE_UPKEEP_ADDRESS: '0x6d8fa4DE0DD0aF71F044266aA630B560733efC96', HOME: '/home/x' };

test('cursor persistence is off and the lookback is the default when unset', () => {
  const config = loadConfig({ ...BASE });
  assert.equal(config.cursorPath, null);
  assert.equal(config.maxLookbackBlocks, DEFAULT_MAX_LOOKBACK_BLOCKS);
});

test('KEEPER_CURSOR_PATH and KEEPER_MAX_LOOKBACK_BLOCKS are read', () => {
  const config = loadConfig({ ...BASE, KEEPER_CURSOR_PATH: '/var/lib/k/cursor.json', KEEPER_MAX_LOOKBACK_BLOCKS: '50' });
  assert.equal(config.cursorPath, '/var/lib/k/cursor.json');
  assert.equal(config.maxLookbackBlocks, 50);
});

test('polling interval, concurrency, receipt timeout, bumps and metrics endpoint have defaults', () => {
  const config = loadConfig({ ...BASE });
  assert.equal(config.pollingIntervalMs, 2_000);
  assert.equal(config.concurrency, 4);
  assert.equal(config.receiptTimeoutMs, 30_000);
  assert.equal(config.maxGasBumps, 3);
  assert.equal(config.metricsHost, '127.0.0.1');
  assert.equal(config.metricsPort, 9465);
});

test('they are all overridable from the environment', () => {
  const config = loadConfig({
    ...BASE,
    KEEPER_POLLING_INTERVAL_MS: '500',
    KEEPER_CONCURRENCY: '1',
    KEEPER_RECEIPT_TIMEOUT_MS: '10000',
    KEEPER_MAX_GAS_BUMPS: '0',
    KEEPER_METRICS_HOST: '0.0.0.0',
    KEEPER_METRICS_PORT: '9999',
  });
  assert.equal(config.pollingIntervalMs, 500);
  assert.equal(config.concurrency, 1);
  assert.equal(config.receiptTimeoutMs, 10_000);
  assert.equal(config.maxGasBumps, 0);
  assert.equal(config.metricsHost, '0.0.0.0');
  assert.equal(config.metricsPort, 9999);
});

test('a malformed number is fatal at startup rather than a NaN interval', () => {
  assert.throws(() => loadConfig({ ...BASE, KEEPER_POLLING_INTERVAL_MS: 'fast' }), /KEEPER_POLLING_INTERVAL_MS/);
  assert.throws(() => loadConfig({ ...BASE, KEEPER_CONCURRENCY: '0' }), /KEEPER_CONCURRENCY/);
  assert.throws(() => loadConfig({ ...BASE, KEEPER_MAX_RETRIES: '-1' }), /KEEPER_MAX_RETRIES/);
});
