// ---------------------------------------------------------------------------
// tradeId inference — read this before touching MarketOpenExecuted /
// LimitOpenExecuted handling.
//
// Neither MarketOpenExecuted nor LimitOpenExecuted (in
// contracts/src/vendor/ostium/interfaces/IOstiumTradingCallbacks.sol)
// includes an explicit `tradeId` field — only the request's `orderId` and
// the resulting `Trade` struct (which itself has no id field either).
//
// This was verified directly against real Whitechain testnet 1874 data
// (deployments/1874-operational.json's proof trade): the open order
// (MarketOpenOrderInitiated / MarketOpenExecuted) used orderId=2. The close
// event for that same position, MarketCloseExecutedV2, has an indexed
// `tradeId` topic — and its value is 2, i.e. it equals the *open* order's
// id. See test/decode.test.ts, which decodes both real logs and asserts
// this equality, plus the exact known price/collateral from that trade.
//
// Conclusion, applied consistently in this indexer: for a trade opened via
// a MARKET order, tradeId === the open order's orderId.
//
// For LIMIT/STOP opens (LimitOpenExecuted), no example exists on testnet
// 1874 yet (only the one market-order proof trade has executed there at the
// time of writing). This indexer applies the same orderId===tradeId
// convention for consistency with the market-order case, but that specific
// case is INFERRED, not independently confirmed against real chain data —
// flagged here and in docs/decisions/phase-4-indexer-api.md.
// ---------------------------------------------------------------------------

/** The tradeId for a position opened by the order with this orderId. */
export function tradeIdFromOpenOrderId(orderId: bigint): bigint {
  return orderId;
}
