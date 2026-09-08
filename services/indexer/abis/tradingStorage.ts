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
] as const;
