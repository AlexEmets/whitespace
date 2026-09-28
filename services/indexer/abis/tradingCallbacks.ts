// Event fragments transcribed from
// contracts/src/vendor/ostium/interfaces/IOstiumTradingCallbacks.sol.
// MarketOpenExecuted and MarketCloseExecutedV2 were verified byte-for-byte
// against real decoded logs from Whitechain testnet 1874 (orderId=2 open,
// orderId=3/tradeId=2 close) — see test/decode.test.ts. Their topic0 values
// match `cast keccak` on these exact signatures.
import { TRADE_COMPONENTS } from './trade.js';

export const tradingCallbacksAbi = [
  {
    type: 'event',
    name: 'MarketOpenExecuted',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 't', type: 'tuple', indexed: false, components: TRADE_COMPONENTS },
      { name: 'priceImpactP', type: 'uint256', indexed: false },
      { name: 'tradeNotional', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MarketCloseExecutedV2',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'price', type: 'uint256', indexed: false },
      { name: 'priceImpactP', type: 'uint256', indexed: false },
      { name: 'percentProfit', type: 'int256', indexed: false },
      { name: 'usdcSentToTrader', type: 'uint256', indexed: false },
      { name: 'percentageClosed', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LimitOpenExecuted',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'limitIndex', type: 'uint256', indexed: false },
      { name: 't', type: 'tuple', indexed: false, components: TRADE_COMPONENTS },
      { name: 'priceImpactP', type: 'uint256', indexed: false },
      { name: 'tradeNotional', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LimitCloseExecuted',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'orderType', type: 'uint8', indexed: false },
      { name: 'price', type: 'uint256', indexed: false },
      { name: 'priceImpactP', type: 'uint256', indexed: false },
      { name: 'percentProfit', type: 'int256', indexed: false },
      { name: 'usdcSentToTrader', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MarketOpenCanceled',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint256', indexed: true },
      { name: 'cancelReason', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MarketCloseCanceled',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint256', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
      { name: 'cancelReason', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AutomationOpenOrderCanceled',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint256', indexed: true },
      { name: 'cancelReason', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AutomationCloseOrderCanceled',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint256', indexed: false },
      { name: 'orderType', type: 'uint8', indexed: false },
      { name: 'cancelReason', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RemoveCollateralExecuted',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: false },
      { name: 'removeAmount', type: 'uint256', indexed: false },
      { name: 'leverage', type: 'uint32', indexed: false },
      { name: 'tp', type: 'uint192', indexed: false },
      { name: 'sl', type: 'uint192', indexed: false },
    ],
  },
  // --- Fee events (fee_charge). The callbacks' OracleFeeCharged has no pairIndex, unlike
  // the same-named declaration in IOstiumTrading, which Trading never emits.
  {
    type: 'event',
    name: 'DevFeeCharged',
    inputs: [
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OracleFeeCharged',
    inputs: [
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VaultOpeningFeeCharged',
    inputs: [
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VaultLiqFeeCharged',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeesChargedV2',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'rolloverFees', type: 'int256', indexed: false },
      { name: 'fundingFees', type: 'int256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OracleFeeBondCharged',
    inputs: [
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'collateral', type: 'uint256', indexed: false },
      { name: 'leverage', type: 'uint32', indexed: false },
      { name: 'tp', type: 'uint192', indexed: false },
      { name: 'sl', type: 'uint192', indexed: false },
    ],
  },
] as const;
