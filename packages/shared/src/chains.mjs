export const CHAINS = {
  1874: {
    id: 1874,
    name: 'whitechain-testnet-op',
    rpc: 'https://rpc.testnet.whitechain.io',
    expects: { eip1559: true, cancun: true, create2Factory: true, multicall3: true },
  },
  2625: {
    id: 2625,
    name: 'whitechain-testnet-legacy',
    rpc: 'https://rpc-testnet.whitechain.io',
    expects: { eip1559: false, cancun: false, create2Factory: false, multicall3: false },
  },
  1875: {
    id: 1875,
    name: 'whitechain-mainnet',
    rpc: 'https://rpc.whitechain.io',
    expects: { eip1559: false, cancun: false, create2Factory: false, multicall3: true },
  },
};
