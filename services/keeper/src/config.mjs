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

/**
 * @returns {{
 *   chainId: number,
 *   priceUpKeepAddress: `0x${string}`,
 *   rpcUrls: string[],
 *   publisherBaseUrl: string,
 *   forwarderKeyPath: string,
 *   pollingIntervalMs: number,
 *   maxRetries: number,
 *   deadLetterFilePath: string,
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

  return { chainId, priceUpKeepAddress, rpcUrls, publisherBaseUrl, forwarderKeyPath, pollingIntervalMs, maxRetries, deadLetterFilePath };
}

/** @param {string} path */
export function loadForwarderKey(path) {
  return loadKeyFile(path);
}
