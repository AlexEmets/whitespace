// Event fragment transcribed from
// contracts/src/vendor/ostium/interfaces/IOstiumTradingStorage.sol.
// MaxOpenInterestUpdated was confirmed against a real on-chain log at block
// 0x6f276d on Whitechain testnet 1874: pairIndex=0, value=1_000_000_000_000
// (PRECISION_6), matching deployments/1874-operational.json's
// market.maxOpenInterest exactly.
export const tradingStorageAbi = [
  {
    type: 'event',
    name: 'MaxOpenInterestUpdated',
    inputs: [
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  // The public getter for `mapping(uint16 pairIndex => uint256[3]) openInterest`
  // (OstiumTradingStorage.sol:64), whose slots are
  // [0] notional long (18 dec), [1] notional short (18 dec), [2] $ max (6 dec).
  //
  // Only slot 2 is read by this indexer, and only to seed `market.maxOpenInterest` when
  // the MaxOpenInterestUpdated log that would have carried it is inside the endpoint's
  // pruned range. Slot 2 is in the same units the event carries, so the seeded value and
  // the event-driven value are interchangeable. See src/lib/seedMarkets.ts.
  {
    type: 'function',
    name: 'openInterest',
    stateMutability: 'view',
    inputs: [
      { name: 'pairIndex', type: 'uint16' },
      { name: 'slot', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
