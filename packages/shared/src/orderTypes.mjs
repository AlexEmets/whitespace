/**
 * IOstiumPriceUpKeep.OrderType, mirrored from
 * contracts/src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol:
 *   enum OrderType { MARKET_OPEN, MARKET_CLOSE, LIMIT_OPEN, LIMIT_CLOSE, REMOVE_COLLATERAL }
 * Kept here, not re-declared per service, so a change on either side is caught by one
 * source going out of sync rather than two silently drifting.
 */

export const ORDER_TYPE_NAMES = ['MARKET_OPEN', 'MARKET_CLOSE', 'LIMIT_OPEN', 'LIMIT_CLOSE', 'REMOVE_COLLATERAL'];

/**
 * @param {number|bigint} value the uint8 enum value from a PriceRequestedV2 log
 * @returns {string}
 */
export function orderTypeName(value) {
  const idx = typeof value === 'bigint' ? Number(value) : value;
  const name = ORDER_TYPE_NAMES[idx];
  if (!name) throw new Error(`orderTypeName: unknown order type ${value}`);
  return name;
}
