import { parseAbi } from 'viem';

/**
 * Hand-picked write/read surface actually used by the UI, transcribed directly from
 * contracts/src/vendor/ostium/interfaces/IOstiumTrading.sol,
 * IOstiumTradingStorage.sol (the `Trade`/`BuilderFee` structs) and IOstiumVault.sol.
 * Not the full interface — only what apps/web calls. Do not hand-guess a signature;
 * every entry below has a `// source:` comment pointing at the exact interface line
 * shape it was read from.
 */

// source: IOstiumTradingStorage.Trade / BuilderFee, IOstiumTrading.openTrade /
// closeTradeMarket / openTradeMarketTimeout / closeTradeMarketTimeout, and the
// MarketOpenOrderInitiated / MarketCloseOrderInitiatedV2 events used to recover the
// orderId assigned to a just-submitted request.
export const TRADING_ABI = parseAbi([
  'function openTrade((uint256 collateral,uint192 openPrice,uint192 tp,uint192 sl,address trader,uint32 leverage,uint16 pairIndex,uint8 index,bool buy,bool isDayTrade) t, (address builder,uint32 builderFee) bf, uint8 orderType, uint256 slippageP)',
  'function closeTradeMarket(uint16 pairIndex, uint8 index, uint16 closePercentage, uint192 marketPrice, uint32 slippageP)',
  'function openTradeMarketTimeout(uint256 _order)',
  'function closeTradeMarketTimeout(uint256 _order, bool retry)',
  'function marketOrdersTimeout() view returns (uint16)',
  'event MarketOpenOrderInitiated(uint256 indexed orderId, address indexed trader, uint16 indexed pairIndex)',
  'event MarketCloseOrderInitiatedV2(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint16 pairIndex, uint16 closePercentage)',
]);

// source: IOstiumVault.sol async deposit/withdraw section.
export const VAULT_ABI = parseAbi([
  'function requestDeposit(uint256 assets)',
  'function requestWithdraw(uint256 shares)',
  'function cancelRequestDeposit(uint32 settlementId, uint256 assets)',
  'function cancelRequestWithdraw(uint32 settlementId, uint256 shares)',
  'function claimDeposit(uint32 settlementId)',
  'function claimWithdraw(uint32 settlementId)',
  'function reclaimDeposit(uint32 settlementId)',
  'function reclaimWithdraw(uint32 settlementId)',
  'function targetSettlementId(bool isDeposit) view returns (uint32)',
  'function getDepositStatus(address owner, uint32 settlementId) view returns (uint8)',
  'function getWithdrawStatus(address owner, uint32 settlementId) view returns (uint8)',
  'function currentBalance() view returns (uint256)',
  'function tvl() view returns (uint256)',
  'event DepositRequestedV2(address indexed owner, uint32 indexed settlementId, uint256 assets)',
  'event WithdrawRequestedV2(address indexed owner, uint32 indexed settlementId, uint256 shares)',
]);

/** IOstiumVault.RequestStatus: NONE, PENDING, CLAIMABLE, RECLAIMABLE. */
export const VAULT_REQUEST_STATUS = ['NONE', 'PENDING', 'CLAIMABLE', 'RECLAIMABLE'] as const;
export type VaultRequestStatus = (typeof VAULT_REQUEST_STATUS)[number];

// source: contracts/src/vendor/ostium/interfaces/TokenInterfaceV5.sol plus the standard
// ERC20 `decimals()` view (USDW is a plain OpenZeppelin ERC20, see
// contracts/src/mocks/USDW.sol) and USDW's own testnet `claim()` faucet.
export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function claim()',
]);

// source: IOstiumPairInfos.sol `pairOpeningFees` (PairOpeningFees struct: makerFeeP,
// takerFeeP, usageFeeP all PRECISION_6 percent) and IOstiumPairsStorage.sol
// `pairOracleFee` (PRECISION_6 USDC, flat fee per order). Real reads, used instead of
// the mockup's fee figures per the phase-5 design-honesty ruling: "show fees sourced
// from chain/API, not the mockup's numbers."
// Liquidation price comes from the contract, in two shapes, because the two questions the
// UI asks are genuinely different:
//
//   getTradeLiquidationPrice     — for a position that EXISTS. It reads that trade's stored
//                                  funding accumulator (`tradeInitialAccFees[trader][pair]
//                                  [index]`) and its accrued rollover, so it is only
//                                  meaningful for a real (trader, pairIndex, index) slot.
//                                  This is the Liq. column in the positions table.
//   getTradeLiquidationPricePure — takes rollover and funding as ARGUMENTS instead of
//                                  reading them. A trade that does not exist yet has
//                                  accrued neither, so passing 0/0 is exactly right for the
//                                  order form's "if I opened this now" estimate — and it
//                                  means the estimate is still the contract's own formula
//                                  rather than a reimplementation of it here.
//
// Both are `view` in OstiumPairInfos.sol (:775 and :806) even though other members of
// IOstiumPairInfos are not, so both are safe reads.
export const PAIR_INFOS_ABI = parseAbi([
  // `view`, though IOstiumPairInfos.sol declares it without the modifier — it is the
  // auto-generated getter for `mapping(uint16 => PairOpeningFees) public pairOpeningFees`
  // (OstiumPairInfos.sol:54), which is always view. Copying the interface's omission made
  // wagmi's useReadContract reject the whole ABI's read surface the moment a genuinely
  // `view` entry was added alongside it.
  'function pairOpeningFees(uint16 pairIndex) view returns (uint32 makerFeeP, uint32 takerFeeP, uint32 usageFeeP, uint16 utilizationThresholdP, uint16 makerMaxLeverage, uint8 vaultFeePercent)',
  'function getTradeLiquidationPrice(address trader, uint16 pairIndex, uint8 index, uint256 openPrice, bool long, uint256 collateral, uint32 leverage, uint32 maxLeverage) view returns (uint256)',
  'function getTradeLiquidationPricePure(uint256 openPrice, bool long, uint256 collateral, uint32 leverage, int256 rolloverFee, int256 fundingFee, uint32 maxLeverage) view returns (uint256)',
]);

export const PAIRS_STORAGE_ABI = parseAbi(['function pairOracleFee(uint16 pairIndex) view returns (uint64)']);

/** IOstiumTradingStorage.OpenOrderType: MARKET, LIMIT, STOP. This UI only submits
 * MARKET orders — LIMIT/STOP exist on-chain but their management UI (place, list,
 * cancel resting limit orders) is out of scope for the phase-5 completion gate; TWAP
 * does not exist in the contracts at all (see IOstiumTradingStorage.OpenOrderType). */
export const OPEN_ORDER_TYPE_MARKET = 0;

/**
 * IOstiumTradingCallbacks.CancelReason, transcribed from
 * contracts/src/vendor/ostium/interfaces/IOstiumTradingCallbacks.sol. The keeper report
 * that cancels a pending order carries one of these; the API is expected to surface the
 * name (or the raw uint8) on the order record so the UI can explain *why* to the trader
 * rather than just saying "cancelled".
 */
export const CANCEL_REASONS = [
  'NONE',
  'PAUSED',
  'MARKET_CLOSED',
  'SLIPPAGE',
  'TP_REACHED',
  'SL_REACHED',
  'EXPOSURE_LIMITS',
  'PRICE_IMPACT',
  'MAX_LEVERAGE',
  'NO_TRADE',
  'UNDER_LIQUIDATION',
  'NOT_HIT',
  'GAIN_LOSS',
  'DAY_TRADE_NOT_ALLOWED',
  'CLOSE_DAY_TRADE_NOT_ALLOWED',
  'WRONG_TRADE',
] as const;

const CANCEL_REASON_EXPLANATIONS: Record<string, string> = {
  SLIPPAGE: 'The execution price moved beyond your slippage tolerance. Your collateral was refunded, minus the oracle fee.',
  MARKET_CLOSED: 'The market was closed or the oracle report was invalid when the report arrived.',
  EXPOSURE_LIMITS: 'This would have exceeded the market open-interest cap.',
  PRICE_IMPACT: 'Price impact for this size exceeded the allowed limit.',
  MAX_LEVERAGE: 'Requested leverage exceeded the market maximum.',
  PAUSED: 'Trading was paused when the report arrived.',
  NO_TRADE: 'No matching trade was found to execute against.',
  WRONG_TRADE: 'The trade no longer matched the original request.',
};

export function explainCancelReason(reason: string): string {
  return (
    CANCEL_REASON_EXPLANATIONS[reason] ??
    'The order was cancelled by the keeper report. Your collateral was refunded, minus the oracle fee.'
  );
}
