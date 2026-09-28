import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, describeConfig } from '../src/config.mjs';

const DEPLOYMENT = {
  chainId: 1874,
  contracts: {
    tradingStorage: '0x0000000000000000000000000000000000000001',
    pairInfos: '0x0000000000000000000000000000000000000002',
    pairsStorage: '0x0000000000000000000000000000000000000003',
    trading: '0x0000000000000000000000000000000000000004',
    tradesUpKeep: '0x0000000000000000000000000000000000000005',
  },
};
const ENV = { DATABASE_URL: 'postgres://bot:s3cret@db:5432/whitespace', LIQUIDATOR_FORWARDER_KEY_PATH: '/keys/bot-1.json' };

test('defaults: addresses from the deployment, safe local bind, spec batch/cooldown defaults', () => {
  const c = loadConfig(ENV, { deployment: DEPLOYMENT });
  assert.equal(c.tradesUpKeepAddress, DEPLOYMENT.contracts.tradesUpKeep);
  assert.equal(c.tradingAddress, DEPLOYMENT.contracts.trading);
  assert.equal(c.databaseSchema, 'public');
  assert.equal(c.instanceName, 'automation-bot');
  assert.equal(c.maxBatchSize, 20);
  assert.equal(c.triggerCooldownMs, 30_000);
  assert.equal(c.liquidateWhenDegraded, true);
  assert.equal(c.metricsHost, '127.0.0.1');
  assert.deepEqual(c.rpcUrls, ['https://rpc.testnet.whitechain.io']);
});

test('two instances differ only in their own env: name, key, port, dead-letter file', () => {
  const one = loadConfig({ ...ENV, LIQUIDATOR_INSTANCE_NAME: 'bot-1', LIQUIDATOR_METRICS_PORT: '9464', LIQUIDATOR_DEAD_LETTER_PATH: '/var/lib/ws/bot-1.json' }, { deployment: DEPLOYMENT });
  const two = loadConfig(
    { ...ENV, LIQUIDATOR_FORWARDER_KEY_PATH: '/keys/bot-2.json', LIQUIDATOR_INSTANCE_NAME: 'bot-2', LIQUIDATOR_METRICS_PORT: '9465', LIQUIDATOR_DEAD_LETTER_PATH: '/var/lib/ws/bot-2.json' },
    { deployment: DEPLOYMENT },
  );
  assert.deepEqual(
    [one.instanceName, one.forwarderKeyPath, one.metricsPort, one.deadLetterFilePath],
    ['bot-1', '/keys/bot-1.json', 9464, '/var/lib/ws/bot-1.json'],
  );
  assert.deepEqual(
    [two.instanceName, two.forwarderKeyPath, two.metricsPort, two.deadLetterFilePath],
    ['bot-2', '/keys/bot-2.json', 9465, '/var/lib/ws/bot-2.json'],
  );
  assert.equal(one.databaseUrl, two.databaseUrl);
});

test('env overrides, including a comma list of RPC urls with spaces', () => {
  const c = loadConfig(
    {
      ...ENV,
      LIQUIDATOR_TRADES_UPKEEP_ADDRESS: '0x00000000000000000000000000000000000000ff',
      DATABASE_SCHEMA: 'indexer',
      LIQUIDATOR_RPC_URLS: 'http://a:1, http://b:2,',
      LIQUIDATOR_MAX_BATCH_SIZE: '5',
      LIQUIDATOR_TRIGGER_COOLDOWN_MS: '45000',
      LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED: 'true',
    },
    { deployment: DEPLOYMENT },
  );
  assert.equal(c.tradesUpKeepAddress, '0x00000000000000000000000000000000000000ff');
  assert.equal(c.databaseSchema, 'indexer');
  assert.deepEqual(c.rpcUrls, ['http://a:1', 'http://b:2']);
  assert.equal(c.maxBatchSize, 5);
  assert.equal(c.triggerCooldownMs, 45_000);
  assert.equal(c.liquidateWhenDegraded, true);
});

test('DATABASE_URL and the forwarder key path are required', () => {
  assert.throws(() => loadConfig({ LIQUIDATOR_FORWARDER_KEY_PATH: '/k' }, { deployment: DEPLOYMENT }), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x' }, { deployment: DEPLOYMENT }), /LIQUIDATOR_FORWARDER_KEY_PATH is required/);
});

test('a deployment without TradesUpKeep is fatal unless the address is given', () => {
  const old = { ...DEPLOYMENT, contracts: { ...DEPLOYMENT.contracts, tradesUpKeep: undefined } };
  assert.throws(() => loadConfig(ENV, { deployment: old }), /tradesUpKeep.*LIQUIDATOR_TRADES_UPKEEP_ADDRESS/);
  assert.throws(() => loadConfig(ENV, { deployment: null }), /tradingStorage/);
});

test('invalid numbers and booleans are rejected, not coerced', () => {
  for (const [key, value] of [
    ['LIQUIDATOR_MAX_BATCH_SIZE', '0'],
    ['LIQUIDATOR_MAX_BATCH_SIZE', '2.5'],
    ['LIQUIDATOR_POLLING_INTERVAL_MS', 'abc'],
    ['LIQUIDATOR_TRIGGER_COOLDOWN_MS', '-1'],
    ['LIQUIDATOR_METRICS_PORT', '9464x'],
  ]) {
    assert.throws(() => loadConfig({ ...ENV, [key]: value }, { deployment: DEPLOYMENT }), new RegExp(`${key} must be a positive integer`));
  }
  assert.throws(() => loadConfig({ ...ENV, LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED: 'maybe' }, { deployment: DEPLOYMENT }), /must be true or false/);
  assert.equal(loadConfig({ ...ENV, LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED: '0' }, { deployment: DEPLOYMENT }).liquidateWhenDegraded, false);
});

test('describeConfig never prints the database password', () => {
  const d = describeConfig(loadConfig(ENV, { deployment: DEPLOYMENT }));
  assert.equal(d.databaseUrl, 'postgres://db:5432/whitespace');
  assert.doesNotMatch(JSON.stringify(d), /s3cret/);
  assert.equal(describeConfig({ databaseUrl: 'nope' }).databaseUrl, 'invalid DATABASE_URL');
});
