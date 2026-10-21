// node --test tools/deploy/liveDeployment.test.mjs
//
// Guard against the single mistake that silently broke production on 2026-10-21: the frontend
// and the indexer both read their contract addresses ONLY from deployments/1874.json (see
// apps/web/src/lib/deployment.ts and services/indexer/ponder.config.ts — neither consults the
// on-chain registry). When that file drifts from the registry the contracts actually resolve
// through, user trades land on a contract whose price-upkeep no keeper serves (stuck "Pending" →
// reclaim), and the indexer watches dead event sources, so 24h volume and open interest read 0
// while trading is live.
//
// These are the addresses the live on-chain registry 0x86d4EC32F8ed6e07D6176b71De05c9866A30c357
// resolves to (verified on-chain 2026-10-21). deployments/1874.json MUST match them, and MUST
// NOT carry any address from the retired 0xBc14f71f deployment. If the stack is ever redeployed,
// regenerate the manifest (tools/deploy/manifest.mjs) AND update the constants below in the same
// change — that is the point: the update is deliberate, never silent drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(REPO, 'deployments/1874.json'), 'utf8'));

// The live set (registry 0x86d4EC32…) — the one the keeper serves and users must trade on.
const LIVE = {
  registry: '0x86d4EC32F8ed6e07D6176b71De05c9866A30c357',
  trading: '0x2379Bc62d7213604175fEfA21b584Ce51A8a01c6',
  tradingStorage: '0x05122cf5B6B3C44e2Ffb4B20C376498E4776FC47',
  callbacks: '0x22253F52D87CfaBef8f1685ECcEFD4dE4Bd4Aa23',
  pairsStorage: '0x2e5CcD43667fCE72e3EDE9Af5E3E1A10DBBA985A',
  vault: '0x0aC538e15e4C7a27E6E38025Bed911B8975044F0',
  collateral: '0x2E652a62314c4b51480E54fC55954f51bf20D2B7',
  priceUpKeep: '0x1E0DBa1e028eE40A0096dD63eaBadB5b4A7c2c99',
};

// The retired set (registry 0xBc14f71f…) — a keeper-less deployment nothing may point at again.
const DEAD_ADDRESSES = [
  '0xBc14f71f6533c74Dc63edeBa1fEC440e564bC4c8', // old registry
  '0x27f3C8c1417eF4215ae39AdC4E10Aee0b1Dc3179', // old trading
  '0x5e8571eD04F985Bbb75d7D04A9335a240e95840c', // old callbacks
  '0x6Eb4b8B62F68D073273A3c829933A3b70D08E047', // old tradingStorage
  '0xA11044f027B7Cff82795B8b6e12bF0096601f913', // old pairsStorage
  '0xac9cb3beF7CA8b120dA082363a83dDA258ad7cf5', // old vault
  '0x76Bd992D57dBA4DB8A956A4f8bAAC514148678a7', // old collateral
  '0x1c84dFAE52e4448196d37Cb9A6611d34BE810dE2', // old priceUpKeep
  '0x71c72543E4A23C64c90bE3d53C13B0F7D6EC534D', // older priceUpKeep
];

test('deployments/1874.json points at the live registry set', () => {
  for (const [key, want] of Object.entries(LIVE)) {
    assert.equal(
      manifest.contracts[key]?.toLowerCase(),
      want.toLowerCase(),
      `contracts.${key} must be the live ${want}, got ${manifest.contracts[key]}`,
    );
  }
});

test('deployments/1874.json carries no address from the retired deployment', () => {
  const blob = JSON.stringify(manifest).toLowerCase();
  for (const dead of DEAD_ADDRESSES) {
    assert.ok(!blob.includes(dead.toLowerCase()), `retired address ${dead} still present in 1874.json`);
  }
});

test('every market resolves to the one keeper-served price upkeep', () => {
  assert.ok(Array.isArray(manifest.markets) && manifest.markets.length > 0, 'no markets in manifest');
  for (const m of manifest.markets) {
    assert.equal(
      m.priceUpKeep?.toLowerCase(),
      LIVE.priceUpKeep.toLowerCase(),
      `market ${m.pairIndex} (${m.from}/${m.to}) points at ${m.priceUpKeep}, not the live upkeep`,
    );
  }
});
