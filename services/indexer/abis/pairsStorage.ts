// Event fragment transcribed from
// contracts/src/vendor/ostium/interfaces/IOstiumPairsStorage.sol.
// PairAdded's topic0 and payload (index=0, from="BTC", to="USD") were
// confirmed directly against a real on-chain log at block 0x6f2767 on
// Whitechain testnet 1874, matching deployments/1874-operational.json's
// market.from/market.to.
//
// Note: PairAdded does NOT carry feed/maxLeverage/groupIndex/feeIndex — a
// direct eth_getLogs sweep for PairMaxLeverageUpdated/PairFeedUpdated near
// the pair-configuration block found no matching events either. The full
// Pair struct (feed, maxLeverage, groupIndex, feeIndex) only exists in
// contract storage, readable via the `pairs(uint16)` view function. The
// PairAdded handler therefore does one bounded `readContract` call to fetch
// the rest of the pair's config — see src/handlers/pairsStorage.ts.
export const pairsStorageAbi = [
  {
    type: 'event',
    name: 'PairAdded',
    inputs: [
      { name: 'index', type: 'uint16', indexed: false },
      { name: 'from', type: 'bytes32', indexed: false },
      { name: 'to', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PairMaxLeverageUpdated',
    inputs: [
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'maxLeverage', type: 'uint32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PairFeedUpdated',
    inputs: [
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'feed', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'pairs',
    stateMutability: 'view',
    inputs: [{ name: 'pairIndex', type: 'uint16' }],
    outputs: [
      { name: 'from', type: 'bytes32' },
      { name: 'to', type: 'bytes32' },
      { name: 'feed', type: 'bytes32' },
      { name: 'tradeSizeRef', type: 'uint64' },
      { name: 'overnightMaxLeverage', type: 'uint32' },
      { name: 'maxLeverage', type: 'uint32' },
      { name: 'groupIndex', type: 'uint8' },
      { name: 'feeIndex', type: 'uint8' },
      { name: 'oracle', type: 'string' },
    ],
  },
] as const;
