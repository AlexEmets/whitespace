/**
 * Keeper configuration. RPC endpoint list, publisher base URL, and retry parameters —
 * all overridable by environment, all defaulting to values read from
 * deployments/1874.json where possible so the common case needs no env at all.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadKeyFile } from '@whitespace/shared/keys';

const DEPLOYMENTS_PATH = fileURLToPath(new URL('../../../deployments/1874.json', import.meta.url));

function readDeployment() {
  try {
    return JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** How far behind the head a resumed cursor may start. Orders older than the report
 * maxAge (10 s) cannot be filled anyway; 300 blocks is minutes of headroom on 1874. */
export const DEFAULT_MAX_LOOKBACK_BLOCKS = 300;

/**
 * @returns {{
 *   chainId: number,
 *   priceUpKeepAddress: `0x${string}`,
 *   rpcUrls: string[],
 *   publisherBaseUrl: string,
 *   forwarderKeyPath: string,
 *   pollingIntervalMs: number,
 *   maxRetries: number,
 *   deadLetterFilePath: string|null,
 *   cursorPath: string|null,
 *   maxLookbackBlocks: number,
 *   concurrency: number,
 *   receiptTimeoutMs: number,
 *   maxGasBumps: number,
 *   metricsHost: string,
 *   metricsPort: number,
 * }}
 */
export function loadConfig(env = process.env) {
  const deployment = readDeployment();

  const chainId = Number(env.KEEPER_CHAIN_ID ?? deployment?.chainId ?? 1874);

  const priceUpKeepAddress = env.KEEPER_PRICE_UPKEEP_ADDRESS ?? deployment?.contracts?.priceUpKeep;
  if (!priceUpKeepAddress) {
    throw new Error('loadConfig: no priceUpKeep address (set KEEPER_PRICE_UPKEEP_ADDRESS or deployments/1874.json)');
  }

  // Only one public 1874 RPC endpoint is documented today; the list is still
  // configurable so a second endpoint activates failover without a code change.
  const rpcUrls = env.KEEPER_RPC_URLS ? env.KEEPER_RPC_URLS.split(',') : ['https://rpc.testnet.whitechain.io'];

  const publisherBaseUrl = env.KEEPER_PUBLISHER_URL ?? 'http://127.0.0.1:8787';

  const forwarderKeyPath = env.KEEPER_FORWARDER_KEY_PATH ?? `${env.HOME}/.whitespace-keys/keeper.json`;

  const pollingIntervalMs = Number(env.KEEPER_POLLING_INTERVAL_MS ?? 2_000);
  const maxRetries = Number(env.KEEPER_MAX_RETRIES ?? 3);
  const deadLetterFilePath = env.KEEPER_DEAD_LETTER_PATH ?? null;
  const cursorPath = env.KEEPER_CURSOR_PATH ?? null;
  const maxLookbackBlocks = Number(env.KEEPER_MAX_LOOKBACK_BLOCKS ?? DEFAULT_MAX_LOOKBACK_BLOCKS);
  const concurrency = Number(env.KEEPER_CONCURRENCY ?? 4);
  const receiptTimeoutMs = Number(env.KEEPER_RECEIPT_TIMEOUT_MS ?? 30_000);
  const maxGasBumps = Number(env.KEEPER_MAX_GAS_BUMPS ?? 3);
  // Loopback by default: /metrics names the forwarder's nonce and backlog, which is
  // nobody else's business. Scrape through the host, or set 0.0.0.0 deliberately.
  const metricsHost = env.KEEPER_METRICS_HOST ?? '127.0.0.1';
  const metricsPort = Number(env.KEEPER_METRICS_PORT ?? 9465);

  for (const [name, v, min] of [
    ['KEEPER_POLLING_INTERVAL_MS', pollingIntervalMs, 1],
    ['KEEPER_MAX_RETRIES', maxRetries, 0],
    ['KEEPER_MAX_LOOKBACK_BLOCKS', maxLookbackBlocks, 1],
    ['KEEPER_CONCURRENCY', concurrency, 1],
    ['KEEPER_RECEIPT_TIMEOUT_MS', receiptTimeoutMs, 1],
    ['KEEPER_MAX_GAS_BUMPS', maxGasBumps, 0],
    ['KEEPER_METRICS_PORT', metricsPort, 0],
  ]) {
    if (!Number.isInteger(v) || v < min) throw new Error(`loadConfig: ${name} must be an integer >= ${min}, got ${v}`);
  }

  return {
    chainId,
    priceUpKeepAddress,
    rpcUrls,
    publisherBaseUrl,
    forwarderKeyPath,
    pollingIntervalMs,
    maxRetries,
    deadLetterFilePath,
    cursorPath,
    maxLookbackBlocks,
    concurrency,
    receiptTimeoutMs,
    maxGasBumps,
    metricsHost,
    metricsPort,
  };
}

/** @param {string} path */
export function loadForwarderKey(path) {
  return loadKeyFile(path);
}
