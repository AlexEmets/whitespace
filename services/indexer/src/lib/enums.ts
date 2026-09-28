// Human labels for the on-chain enums used by the events this indexer
// consumes. Index position in each array === the Solidity enum's ordinal —
// transcribed directly from the enum declarations in
// contracts/src/vendor/ostium/interfaces/IOstiumTradingStorage.sol and
// IOstiumTradingCallbacks.sol. An out-of-range ordinal (should never happen
// for a correctly-decoded event) falls back to `"unknown_<n>"` rather than
// throwing, so a future contract upgrade that adds enum values can't crash
// the indexer.

// IOstiumTradingStorage.LimitOrder
const LIMIT_ORDER_LABELS = [
  'tp',
  'sl',
  'liq',
  'open',
  'close_day_trade',
  'remove_collateral',
  'pending_close',
] as const;

export function limitOrderLabel(ordinal: number): string {
  return LIMIT_ORDER_LABELS[ordinal] ?? `unknown_${ordinal}`;
}

// IOstiumTradingCallbacks.CancelReason
const CANCEL_REASON_LABELS = [
  'none',
  'paused',
  'market_closed',
  'slippage',
  'tp_reached',
  'sl_reached',
  'exposure_limits',
  'price_impact',
  'max_leverage',
  'no_trade',
  'under_liquidation',
  'not_hit',
  'gain_loss',
  'day_trade_not_allowed',
  'close_day_trade_not_allowed',
  'wrong_trade',
] as const;

export function cancelReasonLabel(ordinal: number): string {
  return CANCEL_REASON_LABELS[ordinal] ?? `unknown_${ordinal}`;
}

// IOstiumTradingStorage.OpenOrderType. MARKET never reaches a limit-order event (openTrade
// routes it to the pending-market-order flow), but is labelled rather than rejected.
const OPEN_ORDER_TYPE_LABELS = ['MARKET', 'LIMIT', 'STOP'] as const;

export function openOrderTypeLabel(ordinal: number): string {
  return OPEN_ORDER_TYPE_LABELS[ordinal] ?? `unknown_${ordinal}`;
}
