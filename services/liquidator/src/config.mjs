/**
 * Automation bot configuration: env first, then deployments/1874.json, then defaults.
 *
 * Two instances run side by side with no coordination (design spec §1, §4): each gets its
 * own env file with its own LIQUIDATOR_INSTANCE_NAME, LIQUIDATOR_FORWARDER_KEY_PATH,
 * LIQUIDATOR_METRICS_PORT and LIQUIDATOR_DEAD_LETTER_PATH. They read the same indexer
 * database and race on chain; the loser's trigger comes back PENDING_TRIGGER / NO_TRADE,
 * a status rather than a revert, so a lost race costs gas and nothing else.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadKeyFile } from '@whitespace/shared/keys';
import { DEFAULT_MAX_BATCH_SIZE, DEFAULT_COOLDOWN_MS } from './automationEngine.mjs';

const DEPLOYMENTS_PATH = fileURLToPath(new URL('../../../deployments/1874.json', import.meta.url));

function readDeployment() {
  try {
    return JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function positiveInt(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`loadConfig: ${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

function bool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`loadConfig: ${key} must be true or false, got ${JSON.stringify(raw)}`);
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @param {{ deployment?: any }} [opts] injectable for tests
 */
export function loadConfig(env = process.env, { deployment = readDeployment() } = {}) {
  const chainId = Number(env.LIQUIDATOR_CHAIN_ID ?? deployment?.chainId ?? 1874);

  function requireAddress(envKey, deploymentKey) {
    const value = env[envKey] || deployment?.contracts?.[deploymentKey];
    if (!value) throw new Error(`loadConfig: no ${deploymentKey} address (set ${envKey} or deployments/1874.json)`);
    return value;
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('loadConfig: DATABASE_URL is required (the indexer Postgres the candidates are read from)');

  if (!env.LIQUIDATOR_FORWARDER_KEY_PATH) {
    throw new Error('loadConfig: LIQUIDATOR_FORWARDER_KEY_PATH is required (each instance signs with its own forwarder key)');
  }

  return {
    chainId,
    instanceName: env.LIQUIDATOR_INSTANCE_NAME || 'automation-bot',
    tradingStorageAddress: requireAddress('LIQUIDATOR_TRADING_STORAGE_ADDRESS', 'tradingStorage'),
    pairInfosAddress: requireAddress('LIQUIDATOR_PAIR_INFOS_ADDRESS', 'pairInfos'),
    pairsStorageAddress: requireAddress('LIQUIDATOR_PAIRS_STORAGE_ADDRESS', 'pairsStorage'),
    tradingAddress: requireAddress('LIQUIDATOR_TRADING_ADDRESS', 'trading'),
    tradesUpKeepAddress: requireAddress('LIQUIDATOR_TRADES_UPKEEP_ADDRESS', 'tradesUpKeep'),
    databaseUrl,
    databaseSchema: env.DATABASE_SCHEMA || 'public',
    rpcUrls: env.LIQUIDATOR_RPC_URLS ? env.LIQUIDATOR_RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean) : ['https://rpc.testnet.whitechain.io'],
    publisherBaseUrl: env.LIQUIDATOR_PUBLISHER_URL || 'http://127.0.0.1:8787',
    forwarderKeyPath: env.LIQUIDATOR_FORWARDER_KEY_PATH,
    pollingIntervalMs: positiveInt(env, 'LIQUIDATOR_POLLING_INTERVAL_MS', 2_000),
    maxRetries: positiveInt(env, 'LIQUIDATOR_MAX_RETRIES', 3),
    maxBatchSize: positiveInt(env, 'LIQUIDATOR_MAX_BATCH_SIZE', DEFAULT_MAX_BATCH_SIZE),
    triggerCooldownMs: positiveInt(env, 'LIQUIDATOR_TRIGGER_COOLDOWN_MS', DEFAULT_COOLDOWN_MS),
    liquidateWhenDegraded: bool(env, 'LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED', true),
    deadLetterFilePath: env.LIQUIDATOR_DEAD_LETTER_PATH || null,
    metricsPort: positiveInt(env, 'LIQUIDATOR_METRICS_PORT', 9464),
    metricsHost: env.LIQUIDATOR_METRICS_HOST || '127.0.0.1',
  };
}

/**
 * What is safe to print at startup: everything except the database password.
 * @param {ReturnType<typeof loadConfig>} config
 */
export function describeConfig(config) {
  let db = 'invalid DATABASE_URL';
  try {
    const u = new URL(config.databaseUrl);
    db = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    /* keep the placeholder */
  }
  return { ...config, databaseUrl: db };
}

/** @param {string} path */
export function loadForwarderKey(path) {
  return loadKeyFile(path);
}
