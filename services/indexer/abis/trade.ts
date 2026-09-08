// Shared Trade tuple component, transcribed field-for-field from
// contracts/src/vendor/ostium/interfaces/IOstiumTradingStorage.sol (struct Trade).
// Reused by MarketOpenExecuted / LimitOpenExecuted below.
export const TRADE_COMPONENTS = [
  { name: 'collateral', type: 'uint256' },
  { name: 'openPrice', type: 'uint192' },
  { name: 'tp', type: 'uint192' },
  { name: 'sl', type: 'uint192' },
  { name: 'trader', type: 'address' },
  { name: 'leverage', type: 'uint32' },
  { name: 'pairIndex', type: 'uint16' },
  { name: 'index', type: 'uint8' },
  { name: 'buy', type: 'bool' },
  { name: 'isDayTrade', type: 'bool' },
] as const;
