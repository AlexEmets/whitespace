/**
 * Liquidator configuration. Mirrors services/keeper/src/config.mjs's shape (env
 * overridable, defaults read from deployments/1874.json).
 *
 * IMPORTANT GAP, not something this module can paper over: `deployments/1874.json` has
 * no `tradesUpKeep` address. `contracts/script/Deploy.s.sol` never deploys
 * `OstiumTradesUpKeep`, and `OstiumTrading.executeAutomationOrder` — the only entry
 * point into the LIQ/TP/SL/limit-open automation path — is gated `onlyTradesUpKeep`
 * (`registry.getContractAddress('tradesUpKeep')`, which reverts `NotFound` while
 * unregistered). Concretely: there is currently no way for ANY address, liquidator or
 * otherwise, to trigger an on-chain liquidation on testnet 1874, independent of
 * anything this service does. `tradesUpKeepAddress` is therefore left undefined unless
 * explicitly configured; code paths that need it fail loudly and specifically rather
 * than silently no-op. See docs/decisions/phase-6-liquidator.md for the full writeup
 * and what deploying/registering it would take.
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
 *   tradingStorageAddress: `0x${string}`,
 *   pairInfosAddress: `0x${string}`,
 *   pairsStorageAddress: `0x${string}`,
 *   callbacksAddress: `0x${string}`,
 *   tradesUpKeepAddress: `0x${string}`|undefined,
 *   rpcUrls: string[],
 *   publisherBaseUrl: string,
 *   forwarderKeyPath: string,
 *   pollingIntervalMs: number,
 *   maxRetries: number,
 *   deadLetterFilePath: string|null,
 *   metricsPort: number,
 * }}
 */
export function loadConfig(env = process.env) {
  const deployment = readDeployment();

  const chainId = Number(env.LIQUIDATOR_CHAIN_ID ?? deployment?.chainId ?? 1874);

  function requireAddress(envKey, deploymentKey) {
    const value = env[envKey] ?? deployment?.contracts?.[deploymentKey];
    if (!value) {
      throw new Error(`loadConfig: no ${deploymentKey} address (set ${envKey} or deployments/1874.json)`);
    }
    return value;
  }

  const tradingStorageAddress = requireAddress('LIQUIDATOR_TRADING_STORAGE_ADDRESS', 'tradingStorage');
  const pairInfosAddress = requireAddress('LIQUIDATOR_PAIR_INFOS_ADDRESS', 'pairInfos');
  const pairsStorageAddress = requireAddress('LIQUIDATOR_PAIRS_STORAGE_ADDRESS', 'pairsStorage');
  const callbacksAddress = requireAddress('LIQUIDATOR_CALLBACKS_ADDRESS', 'callbacks');
  // Deliberately NOT requireAddress: see the file header. Absent until TradesUpKeep is
  // deployed and registered.
  const tradesUpKeepAddress = env.LIQUIDATOR_TRADES_UPKEEP_ADDRESS ?? deployment?.contracts?.tradesUpKeep ?? undefined;

  const rpcUrls = env.LIQUIDATOR_RPC_URLS ? env.LIQUIDATOR_RPC_URLS.split(',') : ['https://rpc.testnet.whitechain.io'];
  const publisherBaseUrl = env.LIQUIDATOR_PUBLISHER_URL ?? 'http://127.0.0.1:8787';
  const forwarderKeyPath = env.LIQUIDATOR_FORWARDER_KEY_PATH ?? `${env.HOME}/.whitespace-keys/liquidator.json`;
  const pollingIntervalMs = Number(env.LIQUIDATOR_POLLING_INTERVAL_MS ?? 2_000);
  const maxRetries = Number(env.LIQUIDATOR_MAX_RETRIES ?? 3);
  const deadLetterFilePath = env.LIQUIDATOR_DEAD_LETTER_PATH ?? null;
  const metricsPort = Number(env.LIQUIDATOR_METRICS_PORT ?? 9464);

  return {
    chainId,
    tradingStorageAddress,
    pairInfosAddress,
    pairsStorageAddress,
    callbacksAddress,
    tradesUpKeepAddress,
    rpcUrls,
    publisherBaseUrl,
    forwarderKeyPath,
    pollingIntervalMs,
    maxRetries,
    deadLetterFilePath,
    metricsPort,
  };
}

/** @param {string} path */
export function loadForwarderKey(path) {
  return loadKeyFile(path);
}
