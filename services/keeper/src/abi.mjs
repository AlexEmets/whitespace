/**
 * The slice of IOstiumPriceUpKeep the keeper needs, mirrored from
 * contracts/src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol and
 * IOstiumForwarded.sol. Read-only reference to the contract source — nothing under
 * contracts/ is written by this service.
 */

import { parseAbi } from 'viem';

export const PRICE_UPKEEP_ABI = parseAbi([
  'event PriceRequestedV2(uint256 indexed orderId, uint8 orderType, bytes32 feed, uint256 timestamp)',
  'function performUpkeep(bytes performData)',
  'error NotForwarder(address a)',
  'error InvalidPrice(uint256 orderId)',
  'error NotInitiated(uint256 a)',
  'error AlreadyInitiated(uint256 a)',
]);
