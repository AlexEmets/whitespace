// Event fragments transcribed from
// contracts/src/vendor/ostium/interfaces/IOstiumVault.sol. The Vault runs an
// async, settlement-based LP model (request -> settlement -> claim), not a
// synchronous ERC-4626 deposit/withdraw. This indexer tracks the two most
// meaningful lifecycle points for "LP deposits/withdrawals": the request
// (assets/shares committed) and the claim (assets/shares actually moved).
export const vaultAbi = [
  {
    type: 'event',
    name: 'DepositRequestedV2',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'settlementId', type: 'uint32', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WithdrawRequestedV2',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'settlementId', type: 'uint32', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DepositClaimedV2',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'settlementId', type: 'uint32', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WithdrawClaimedV2',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'settlementId', type: 'uint32', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
    ],
  },
] as const;
