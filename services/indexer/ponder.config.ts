import { createConfig } from 'ponder';
import { http, fallback } from 'viem';

import deployment from '../../deployments/1874.json' with { type: 'json' };

import { tradingAbi } from './abis/trading.js';
import { tradingCallbacksAbi } from './abis/tradingCallbacks.js';
import { priceUpKeepAbi } from './abis/priceUpKeep.js';
import { pairsStorageAbi } from './abis/pairsStorage.js';
import { tradingStorageAbi } from './abis/tradingStorage.js';
import { vaultAbi } from './abis/vault.js';

// Whitechain testnet 1874 is an OP Stack rollup — see
// docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md §2.2.
// Note: `rpc-testnet.whitechain.io` (hyphen) is chain 2625, a DIFFERENT
// network — never use it here.
const CHAIN_ID = 1874;
const PRIMARY_RPC = 'https://rpc.testnet.whitechain.io';

// RPC failover (design §7: "RPC down -> failover across >=2 endpoints").
// Only one public RPC endpoint for chain 1874 is documented/known at the
// time of writing (see the design spec's chain-probe table, section 2.1) —
// a second one has NOT been verified to exist. PONDER_RPC_URLS_1874 accepts
// a comma-separated list so a second endpoint (e.g. a private/paid RPC) can
// be added purely via config once one exists, without a code change. Until
// then this `fallback()` wraps a single transport, which is a no-op for
// failover but keeps the mechanism real rather than faked.
const rpcUrls = (process.env.PONDER_RPC_URLS_1874 ?? PRIMARY_RPC)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

// All contract addresses below come verbatim from deployments/1874.json
// (the live testnet deployment record) — never hand-typed.
// Where contract indexing begins. Default 7_284_500 — a few hundred blocks before contract
// deployment + pair setup — which is the right answer only if the RPC still serves logs
// that far back. Measured 2026-09-21 against rpc.testnet.whitechain.io, in 10 000-block
// windows (the largest the endpoint accepts — it rejects anything wider with
// "query exceeds max block range 10000"):
//
//   window at 7_280_000 ... 0 logs     window at 8_300_000 ... 59 logs
//   window at 7_370_000 ... 0 logs     window at 8_399_000 ... 67 logs
//   window at 7_900_000 ... 0 logs
//
// The blocks themselves still exist — 7_284_610 returns a block with one transaction — so
// this is a pruned log/receipt index, not a pruned chain. Anything below roughly 8_300_000
// is unreachable no matter how the request is chunked, and a cold sync from the default
// therefore burns hours to import nothing.
//
// Hence: overridable, in the same shape as HEARTBEAT_START_BLOCK below, so that moving it
// is an env change plus `systemctl restart whitespace-indexer` — no rebuild, no redeploy.
// Ponder compiles this file at startup, so there is no build artifact to invalidate.
const startBlock = Number(process.env.CONTRACTS_START_BLOCK ?? 7_284_500);

// Where the liveness heartbeat begins — see the `blocks` section for why this is NOT
// `startBlock`. Overridable so a cold sync months from now does not re-acquire a long
// pointless tail; the default only has to be recent relative to whenever it is bumped.
const heartbeatStartBlock = Number(process.env.HEARTBEAT_START_BLOCK ?? 7_373_000);

export default createConfig({
  chains: {
    whitechain1874: {
      id: CHAIN_ID,
      rpc: fallback(rpcUrls.map((url) => http(url))),
    },
  },
  contracts: {
    Trading: {
      abi: tradingAbi,
      chain: 'whitechain1874',
      address: deployment.contracts.trading as `0x${string}`,
      startBlock,
    },
    TradingCallbacks: {
      abi: tradingCallbacksAbi,
      chain: 'whitechain1874',
      address: deployment.contracts.callbacks as `0x${string}`,
      startBlock,
    },
    PriceUpKeep: {
      abi: priceUpKeepAbi,
      chain: 'whitechain1874',
      address: deployment.contracts.priceUpKeep as `0x${string}`,
      startBlock,
    },
    PairsStorage: {
      abi: pairsStorageAbi,
      chain: 'whitechain1874',
      address: deployment.contracts.pairsStorage as `0x${string}`,
      startBlock,
    },
    TradingStorage: {
      abi: tradingStorageAbi,
      chain: 'whitechain1874',
      address: deployment.contracts.tradingStorage as `0x${string}`,
      startBlock,
    },
    Vault: {
      abi: vaultAbi,
      chain: 'whitechain1874',
      address: deployment.contracts.vault as `0x${string}`,
      startBlock,
    },
  },
  blocks: {
    // Drives the `sync_status` singleton row that GET /health reads
    // (indexedBlock / lagSeconds), so lag is measured even during quiet
    // periods when no contract event fires.
    //
    // This is a LIVENESS signal, and liveness has no history: `sync_status` is
    // a single row that every invocation overwrites, and `handleHealth`
    // compares only the latest one against its 30s/300s thresholds. Backfilling
    // it from `startBlock` therefore did 89,000+ `eth_getBlockByNumber` calls to
    // compute a value that 88,999 of them immediately discarded — and since
    // contract logs arrive via ranged `eth_getLogs` (a handful of requests),
    // that heartbeat WAS the entire backfill cost. Measured at ~6 blocks/s
    // against the public RPC, it put a cold sync at roughly four hours.
    //
    // So it starts near the head instead. `interval: 5` on a ~1s-block OP Stack
    // chain bounds the added staleness at ~5s, comfortably inside the 30s
    // "degraded" threshold, for a fifth of the requests.
    ChainHeartbeat: {
      chain: 'whitechain1874',
      startBlock: heartbeatStartBlock,
      interval: 5,
    },
  },
});
