#!/usr/bin/env node
// Builds deployments/<chainId>.json from the chain itself, after `DeployTestnet.s.sol`.
//
// The first 1874 manifest was assembled by hand across four script runs and drifted from the
// chain (feedKeys listed BTC only while four markets traded). Everything here is READ from
// the registry the contracts themselves resolve through, so the manifest cannot claim an
// address the system does not use.
//
//   REGISTRY_ADDRESS=0x... START_BLOCK=123 RPC_URL=https://rpc.testnet.whitechain.io \
//     node tools/deploy/manifest.mjs > deployments/1874.json
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CORE_KEYS = [
  'tradingStorage',
  'pairsStorage',
  'pairInfos',
  'trading',
  'callbacks',
  'vault',
  'openPnl',
  'priceRouter',
  'tradesUpKeep',
];

const ABI = {
  getContractAddress: 'function getContractAddress(bytes32) view returns (address)',
  gov: 'function gov() view returns (address)',
  manager: 'function manager() view returns (address)',
  dev: 'function dev() view returns (address)',
  owner: 'function owner() view returns (address)',
  asset: 'function asset() view returns (address)',
  pairsCount: 'function pairsCount() view returns (uint16)',
  pairs: 'function pairs(uint16) view returns (bytes32 from, bytes32 to, bytes32 feed, uint256 tradeSizeRef, uint32 overnightMaxLeverage, uint32 maxLeverage, uint16 groupIndex, uint16 feeIndex, string oracle)',
  openInterest: 'function openInterest(uint16, uint256) view returns (uint256)',
  threshold: 'function threshold() view returns (uint256)',
  signerCount: 'function signerCount() view returns (uint256)',
  maxAge: 'function maxAge() view returns (uint32)',
  maxDeviationBps: 'function maxDeviationBps() view returns (uint16)',
  guardian: 'function guardian() view returns (address)',
  marketOrdersTimeout: 'function marketOrdersTimeout() view returns (uint16)',
  triggerTimeout: 'function triggerTimeout() view returns (uint16)',
};

/** bytes32 string key, left-aligned like Solidity's `bytes32("...")`. */
export function toBytes32(text) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > 32) throw new Error(`key longer than 32 bytes: ${text}`);
  return `0x${bytes.toString('hex').padEnd(64, '0')}`;
}

export function fromBytes32(hex) {
  return Buffer.from(hex.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
}

/**
 * @param read async (address, signature, args) => value — injected so this is testable
 *             without a chain.
 */
export async function buildManifest({ read, chainId, registry, startBlock, commit, deployedAt }) {
  const contracts = { registry };
  for (const key of CORE_KEYS) {
    contracts[key] = await read(registry, ABI.getContractAddress, [toBytes32(key)]);
  }
  contracts.collateral = await read(contracts.vault, ABI.asset, []);
  contracts.verifier = await read(registry, ABI.getContractAddress, [toBytes32('ostiumVerifier')]);

  const count = Number(await read(contracts.pairsStorage, ABI.pairsCount, []));
  const markets = [];
  const upkeeps = new Set();
  for (let i = 0; i < count; i++) {
    const p = await read(contracts.pairsStorage, ABI.pairs, [i]);
    const [from, to, feed, , , maxLeverage, groupIndex, feeIndex, oracle] = p;
    const registryKey = `${oracle}PriceUpkeep`;
    const upkeep = await read(registry, ABI.getContractAddress, [toBytes32(registryKey)]);
    upkeeps.add(upkeep.toLowerCase());
    markets.push({
      pairIndex: i,
      from: fromBytes32(from),
      to: fromBytes32(to),
      feedId: fromBytes32(feed),
      oracle,
      registryKey,
      priceUpKeep: upkeep,
      groupIndex: Number(groupIndex),
      feeIndex: Number(feeIndex),
      maxLeverage: Number(maxLeverage),
      maxOpenInterest: (await read(contracts.tradingStorage, ABI.openInterest, [i, 2n])).toString(),
    });
  }
  if (upkeeps.size !== 1) {
    throw new Error(`expected every market to resolve to ONE price upkeep, found ${upkeeps.size}`);
  }
  contracts.priceUpKeep = markets[0].priceUpKeep;

  const oracle = {
    verifier: contracts.verifier,
    priceUpKeep: contracts.priceUpKeep,
    threshold: Number(await read(contracts.verifier, ABI.threshold, [])),
    signerCount: Number(await read(contracts.verifier, ABI.signerCount, [])),
    maxAge: Number(await read(contracts.priceUpKeep, ABI.maxAge, [])),
    maxDeviationBps: Number(await read(contracts.priceUpKeep, ABI.maxDeviationBps, [])),
    guardian: await read(contracts.priceUpKeep, ABI.guardian, []),
    feedKeys: markets.map((m) => m.registryKey),
  };

  return {
    chainId,
    deployedAt,
    commit,
    startBlock,
    contracts,
    roles: {
      gov: await read(registry, ABI.gov, []),
      manager: await read(registry, ABI.manager, []),
      dev: await read(registry, ABI.dev, []),
      owner: await read(registry, ABI.owner, []),
    },
    trading: {
      marketOrdersTimeout: Number(await read(contracts.trading, ABI.marketOrdersTimeout, [])),
      triggerTimeout: Number(await read(contracts.trading, ABI.triggerTimeout, [])),
    },
    oracle,
    markets,
  };
}

async function main() {
  // viem is not a root dependency; borrow the keeper's copy rather than adding one.
  const require = createRequire(new URL('../../services/keeper/package.json', import.meta.url));
  const { createPublicClient, http, parseAbiItem } = await import(pathToFileURL(require.resolve('viem')).href);

  const registry = process.env.REGISTRY_ADDRESS;
  const startBlock = Number(process.env.START_BLOCK);
  if (!registry || !Number.isInteger(startBlock)) {
    throw new Error('REGISTRY_ADDRESS and START_BLOCK are required');
  }
  const client = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://rpc.testnet.whitechain.io') });
  const chainId = await client.getChainId();
  const read = (address, signature, args) =>
    client.readContract({ address, abi: [parseAbiItem(signature)], functionName: signature.match(/function (\w+)/)[1], args });

  const manifest = await buildManifest({
    read,
    chainId,
    registry,
    startBlock,
    commit: execSync('git rev-parse HEAD').toString().trim(),
    deployedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  });
  process.stdout.write(`${JSON.stringify(manifest, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
