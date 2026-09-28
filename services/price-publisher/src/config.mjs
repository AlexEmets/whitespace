/**
 * Publisher configuration. Everything tunable lives here or in
 * @whitespace/shared/bounds — never as a magic number at its use site.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadKeyFiles } from '@whitespace/shared/keys';
import { MARKET_FEEDS } from '@whitespace/shared/markets';
import { VENUE_IDS } from '@whitespace/shared/venues';
import { CONTRACT_REPORT_MAX_AGE_S, PUBLISHER_BOUNDS, SIGNATURE_THRESHOLD_K, boundsForMarket } from '@whitespace/shared/bounds';

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
 *   verifierAddress: `0x${string}`,
 *   host: string,
 *   port: number,
 *   maxReportAgeS: number,
 *   maxClockSkewS: number,
 *   markets: string[],
 *   venues: string[],
 *   bounds: typeof PUBLISHER_BOUNDS,
 *   boundsFor: (feed: string) => typeof PUBLISHER_BOUNDS,
 *   signatureThresholdK: number,
 *   signerKeys: { address: `0x${string}`, privateKey: `0x${string}` }[],
 * }}
 */
export function loadConfig(env = process.env) {
  const deployment = readDeployment();

  const chainId = Number(env.PUBLISHER_CHAIN_ID ?? deployment?.chainId ?? 1874);

  // The k-of-N verifier every signed report is bound to (it is part of the signed
  // payload). deployments/1874.json's `contracts.verifier` is that verifier since the
  // oracle migration; the pre-migration one is under `retiredContracts`.
  const verifierAddress = env.PUBLISHER_VERIFIER_ADDRESS ?? deployment?.contracts?.verifier;
  if (!verifierAddress) {
    throw new Error('loadConfig: no verifier address (set PUBLISHER_VERIFIER_ADDRESS or deployments/1874.json)');
  }

  // Loopback by default. /v2/report hands out signed prices to whoever asks; the keeper,
  // API and bot all run on this host, so nothing else has any business reaching it.
  // Override only behind something that authenticates.
  const host = env.PUBLISHER_HOST ?? '127.0.0.1';
  const port = Number(env.PUBLISHER_PORT ?? 8787);

  // /v2/report signs only timestamps in [now - maxReportAgeS, now + maxClockSkewS].
  const maxReportAgeS = Number(env.PUBLISHER_MAX_REPORT_AGE_S ?? CONTRACT_REPORT_MAX_AGE_S);
  const maxClockSkewS = Number(env.PUBLISHER_MAX_CLOCK_SKEW_S ?? 2);
  for (const [name, v] of [['PUBLISHER_MAX_REPORT_AGE_S', maxReportAgeS], ['PUBLISHER_MAX_CLOCK_SKEW_S', maxClockSkewS]]) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`loadConfig: ${name} must be a non-negative integer, got ${v}`);
  }

  const markets = env.PUBLISHER_MARKETS ? env.PUBLISHER_MARKETS.split(',') : MARKET_FEEDS;
  const venues = env.PUBLISHER_VENUES ? env.PUBLISHER_VENUES.split(',') : VENUE_IDS;

  const signatureThresholdK = Number(env.PUBLISHER_SIGNATURE_THRESHOLD_K ?? SIGNATURE_THRESHOLD_K);

  const signerKeyPaths = env.PUBLISHER_SIGNER_KEY_PATHS
    ? env.PUBLISHER_SIGNER_KEY_PATHS.split(',')
    : [`${env.HOME}/.whitespace-keys/signer.json`];
  const signerKeys = loadKeyFiles(signerKeyPaths);

  if (signerKeys.length < signatureThresholdK) {
    // Not fatal by itself here — server.mjs surfaces this per-request as a config
    // error, since a dev box may legitimately run with 1 key for wiring tests. It is
    // fatal for actually producing a valid k-of-N report.
  }

  // `bounds` stays the global default — main.mjs still needs one sampling interval for its
  // timer, and it is what a feed with no override resolves to anyway. `boundsFor` is the
  // per-market resolver the engine uses to judge each feed.
  return {
    chainId,
    verifierAddress,
    host,
    port,
    maxReportAgeS,
    maxClockSkewS,
    markets,
    venues,
    bounds: PUBLISHER_BOUNDS,
    boundsFor: boundsForMarket,
    signatureThresholdK,
    signerKeys,
  };
}
