// Event fragments transcribed from
// contracts/src/vendor/ostium/interfaces/IOstiumTrading.sol.
// Only the events this indexer consumes are included (Ponder only needs the
// events it subscribes to; the full interface also has admin/error surface
// this indexer does not touch). Every signature below was cross-checked
// against a real decoded log from Whitechain testnet 1874 — see
// docs/decisions/phase-4-indexer-api.md and test/decode.test.ts.
import { TRADE_COMPONENTS } from './trade.js';

const PENDING_MARKET_ORDER_V2_COMPONENTS = [
  { name: 'block', type: 'uint256' },
  { name: 'wantedPrice', type: 'uint192' },
  { name: 'slippageP', type: 'uint32' },
  { name: 'trade', type: 'tuple', components: TRADE_COMPONENTS },
  { name: 'percentage', type: 'uint16' },
] as const;

const BUILDER_FEE_COMPONENTS = [
  { name: 'builder', type: 'address' },
  { name: 'builderFee', type: 'uint32' },
] as const;

export const tradingAbi = [
  // --- Limit / stop entries. OpenLimitPlacedV2 is the only placement event
  // OstiumTrading.openTrade emits (the V1 OpenLimitPlaced is declared but never emitted).
  {
    type: 'event',
    name: 'OpenLimitPlacedV2',
    inputs: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'index', type: 'uint8', indexed: false },
      { name: 'trade', type: 'tuple', indexed: false, components: TRADE_COMPONENTS },
      { name: 'orderType', type: 'uint8', indexed: false }, // IOstiumTradingStorage.OpenOrderType
      { name: 'builderFee', type: 'tuple', indexed: false, components: BUILDER_FEE_COMPONENTS },
    ],
  },
  {
    type: 'event',
    name: 'OpenLimitUpdated',
    inputs: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'index', type: 'uint8', indexed: false },
      { name: 'newPrice', type: 'uint192', indexed: false },
      { name: 'newTp', type: 'uint192', indexed: false },
      { name: 'newSl', type: 'uint192', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OpenLimitCanceled',
    inputs: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'index', type: 'uint8', indexed: false },
    ],
  },
  // cancelOpenLimitOrder keeps one oracle fee out of the refunded collateral.
  {
    type: 'event',
    name: 'OracleFeeChargedLimitCancelled',
    inputs: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MarketOpenOrderInitiated',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'MarketCloseOrderInitiatedV2',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: false },
      { name: 'closePercentage', type: 'uint16', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TpUpdated',
    inputs: [
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'index', type: 'uint8', indexed: false },
      { name: 'newTp', type: 'uint192', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SlUpdated',
    inputs: [
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'index', type: 'uint8', indexed: false },
      { name: 'newSl', type: 'uint192', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TopUpCollateralExecuted',
    inputs: [
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'topUpAmount', type: 'uint256', indexed: false },
      { name: 'newLeverage', type: 'uint32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RemoveCollateralInitiated',
    inputs: [
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: false },
      { name: 'removeAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MarketOpenTimeoutExecutedV2',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'order', type: 'tuple', indexed: false, components: PENDING_MARKET_ORDER_V2_COMPONENTS },
    ],
  },
  {
    type: 'event',
    name: 'MarketCloseTimeoutExecutedV2',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'order', type: 'tuple', indexed: false, components: PENDING_MARKET_ORDER_V2_COMPONENTS },
    ],
  },
  {
    type: 'event',
    name: 'AutomationOpenOrderInitiated',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: true },
      { name: 'index', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AutomationCloseOrderInitiated',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'pairIndex', type: 'uint16', indexed: false },
      { name: 'orderType', type: 'uint8', indexed: false },
    ],
  },
] as const;
