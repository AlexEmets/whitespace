// Event fragments transcribed from
// contracts/src/vendor/ostium/interfaces/IOstiumVault.sol. The Vault runs an
// async, settlement-based LP model (request -> settlement -> claim), not a
// synchronous ERC-4626 deposit/withdraw. This indexer tracks the two most
// meaningful lifecycle points for "LP deposits/withdrawals": the request
// (assets/shares committed) and the claim (assets/shares actually moved).
export const vaultAbi = [
  // --- Settlement (vault_settlement). _settlement() emits AsyncDepositWithdrawExecuted
  // (from _executeAsyncDepositWithdraw) and then SettlementExecuted, both for the same
  // lastSettlementId.
  {
    type: 'event',
    name: 'SettlementExecuted',
    inputs: [
      { name: 'settlementId', type: 'uint32', indexed: true },
      { name: 'settlementTs', type: 'uint32', indexed: false },
      { name: 'settlementOpenPnl', type: 'int256', indexed: false },
      { name: 'settlementType', type: 'uint8', indexed: false },
      { name: 'accPnlPerTokenUsed', type: 'int256', indexed: false },
      { name: 'accRewardsPerToken', type: 'uint256', indexed: false },
      { name: 'shareToAssetsPrice', type: 'uint256', indexed: false },
      { name: 'totalClosedPnl', type: 'int256', indexed: false },
      { name: 'totalSupply', type: 'uint256', indexed: false },
      { name: 'totalAssets', type: 'uint256', indexed: false },
      { name: 'bufferSize', type: 'int256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AsyncDepositWithdrawExecuted',
    inputs: [
      { name: 'settlementId', type: 'uint32', indexed: true },
      { name: 'deltaShares', type: 'int256', indexed: false },
      { name: 'totalAssetsToDeposit', type: 'uint256', indexed: false },
      { name: 'totalSharesToWithdraw', type: 'uint256', indexed: false },
      { name: 'shareToAssetsPrice', type: 'uint256', indexed: false },
    ],
  },
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
