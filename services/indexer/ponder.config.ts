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
const startBlock = 7_284_500; // a few hundred blocks before contract deployment + pair setup

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
    // (indexedBlock / lagSeconds). Every block, not just blocks that
    // happen to contain a matching event, so lag is measured accurately
    // even during quiet periods.
    ChainHeartbeat: {
      chain: 'whitechain1874',
      startBlock,
      interval: 1,
    },
  },
});
