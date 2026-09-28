import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, fromBytes32, toBytes32 } from './manifest.mjs';

const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;

/** A fake chain: the registry and every contract answer from tables. */
function fakeChain({ upkeepFor = () => addr(0x50) } = {}) {
  const registry = addr(1);
  const keys = {
    tradingStorage: addr(2), pairsStorage: addr(3), pairInfos: addr(4), trading: addr(5), callbacks: addr(6),
    vault: addr(7), openPnl: addr(8), priceRouter: addr(9), tradesUpKeep: addr(10), ostiumVerifier: addr(11),
  };
  const pairs = [
    ['BTC', 'USD', 10000, 1_000_000_000_000n],
    ['WBT', 'USD', 2500, 100_000_000_000n],
  ];
  async function read(address, sig, args) {
    const fn = sig.match(/function (\w+)/)[1];
    if (address === registry && fn === 'getContractAddress') {
      const key = fromBytes32(args[0]);
      if (key.endsWith('PriceUpkeep')) return upkeepFor(key);
      if (!(key in keys)) throw new Error(`NotFound(${key})`);
      return keys[key];
    }
    if (fn === 'gov') return addr(0x60);
    if (fn === 'manager') return addr(0x61);
    if (fn === 'dev') return addr(0x62);
    if (fn === 'owner') return addr(0x63);
    if (fn === 'asset') return addr(0x70);
    if (fn === 'pairsCount') return pairs.length;
    if (fn === 'pairs') {
      const [from, to, lev] = pairs[args[0]];
      return [toBytes32(from), toBytes32(to), toBytes32(`${from}/${to}`), 0n, 0, lev, 0, 0, `${from}/${to}`];
    }
    if (fn === 'openInterest') return pairs[args[0]][3];
    if (fn === 'threshold') return 3n;
    if (fn === 'signerCount') return 5n;
    if (fn === 'maxAge') return 10;
    if (fn === 'maxDeviationBps') return 500;
    if (fn === 'guardian') return addr(0x64);
    if (fn === 'marketOrdersTimeout') return 11;
    if (fn === 'triggerTimeout') return 30;
    throw new Error(`unexpected read ${fn} on ${address}`);
  }
  return { read, registry, keys };
}

test('bytes32 keys round-trip and refuse more than 32 bytes', () => {
  assert.equal(fromBytes32(toBytes32('BTC/USDPriceUpkeep')), 'BTC/USDPriceUpkeep');
  assert.equal(toBytes32('a').length, 66);
  assert.throws(() => toBytes32('x'.repeat(33)), /longer than 32/);
});

test('reads every address the system resolves through its registry', async () => {
  const { read, registry, keys } = fakeChain();
  const m = await buildManifest({ read, chainId: 1874, registry, startBlock: 42, commit: 'abc', deployedAt: 't' });
  assert.equal(m.contracts.tradesUpKeep, keys.tradesUpKeep);
  assert.equal(m.contracts.verifier, keys.ostiumVerifier);
  assert.equal(m.contracts.collateral, addr(0x70));
  assert.equal(m.contracts.priceUpKeep, addr(0x50));
  assert.equal(m.startBlock, 42);
  assert.deepEqual(m.roles, { gov: addr(0x60), manager: addr(0x61), dev: addr(0x62), owner: addr(0x63) });
  assert.deepEqual(m.trading, { marketOrdersTimeout: 11, triggerTimeout: 30 });
});

test('lists every market with its decoded symbols, feed and ceiling', async () => {
  const { read, registry } = fakeChain();
  const m = await buildManifest({ read, chainId: 1874, registry, startBlock: 1, commit: 'c', deployedAt: 't' });
  assert.equal(m.markets.length, 2);
  assert.deepEqual(
    { ...m.markets[1], priceUpKeep: undefined },
    {
      pairIndex: 1, from: 'WBT', to: 'USD', feedId: 'WBT/USD', oracle: 'WBT/USD', registryKey: 'WBT/USDPriceUpkeep',
      priceUpKeep: undefined, groupIndex: 0, feeIndex: 0, maxLeverage: 2500, maxOpenInterest: '100000000000',
    },
  );
  assert.deepEqual(m.oracle.feedKeys, ['BTC/USDPriceUpkeep', 'WBT/USDPriceUpkeep']);
  assert.equal(m.oracle.threshold, 3);
  assert.equal(m.oracle.signerCount, 5);
});

test('refuses a system whose markets resolve to different price upkeeps', async () => {
  const { read, registry } = fakeChain({ upkeepFor: (k) => (k.startsWith('BTC') ? addr(0x50) : addr(0x51)) });
  await assert.rejects(
    buildManifest({ read, chainId: 1874, registry, startBlock: 1, commit: 'c', deployedAt: 't' }),
    /ONE price upkeep, found 2/,
  );
});

test('a missing core key fails loudly instead of writing a partial manifest', async () => {
  const { read, registry } = fakeChain();
  const broken = (a, s, args) => (fromBytes32(args?.[0] ?? '0x') === 'tradesUpKeep' ? Promise.reject(new Error('NotFound(tradesUpKeep)')) : read(a, s, args));
  await assert.rejects(
    buildManifest({ read: broken, chainId: 1874, registry, startBlock: 1, commit: 'c', deployedAt: 't' }),
    /NotFound\(tradesUpKeep\)/,
  );
});
