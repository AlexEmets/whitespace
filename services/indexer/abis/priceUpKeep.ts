// Event fragments transcribed from
// contracts/src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol.
// PriceRequestedV2 and PriceReceived were verified against real decoded logs
// from Whitechain testnet 1874 (see test/decode.test.ts). Note: the deployed
// contract emits PriceRequestedV2, not the V1 PriceRequested — confirmed by
// matching topic0 on-chain, not assumed.
export const priceUpKeepAbi = [
  {
    type: 'event',
    name: 'PriceRequestedV2',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'orderType', type: 'uint8', indexed: false },
      { name: 'feed', type: 'bytes32', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PriceReceived',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'pairIndex', type: 'uint256', indexed: true },
      { name: 'price', type: 'int192', indexed: false },
      { name: 'nativeFee', type: 'uint256', indexed: false },
    ],
  },
] as const;
