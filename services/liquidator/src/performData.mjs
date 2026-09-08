/**
 * Pure ABI encoding for OstiumTradesUpKeep.performUpkeep's payload — no network, so
 * unit-testable directly (see test/performData.test.mjs, round-tripped with viem's own
 * decoder as an independent check).
 *
 * IOstiumAutomationCompatible.SimplifiedTradeId (interfaces/IOstiumAutomationCompatible.sol):
 *   struct SimplifiedTradeId { address trader; uint256 pairId; uint256 index; LimitOrder limitOrder; }
 * OstiumTradesUpKeep.performUpkeep decodes `abi.decode(performData, (SimplifiedTradeId[], uint256))`
 * — an array (so one tx can trigger several candidates at once) plus a single shared
 * `timestamp`, forwarded into `OstiumTrading.executeAutomationOrder`'s `priceTimestamp`
 * argument and, from there, into `priceRouter.getPrice(...)`. That timestamp becomes the
 * `timestamp` field the resulting PriceRequestedV2 log carries — the existing keeper
 * (services/keeper, unmodified) picks that log up and delivers a signed report for it
 * exactly like any other order, with no keeper-side changes needed (see
 * docs/decisions/phase-6-liquidator.md).
 */

import { encodeAbiParameters } from 'viem';
import { LimitOrder } from './abi.mjs';

const SIMPLIFIED_TRADE_ID_ARRAY = {
  type: 'tuple[]',
  components: [
    { name: 'trader', type: 'address' },
    { name: 'pairId', type: 'uint256' },
    { name: 'index', type: 'uint256' },
    { name: 'limitOrder', type: 'uint8' },
  ],
};

/**
 * @param {{ trader: `0x${string}`, pairIndex: number, index: number }[]} candidates
 * @param {number} timestamp uint32-range seconds; passed straight through, never
 *   substituted with Date.now() here (the caller decides the timestamp — see
 *   src/liquidatorLoop.mjs / main.mjs for where that decision is made and why).
 * @returns {`0x${string}`}
 */
export function encodeLiquidationPerformData(candidates, timestamp) {
  const trades = candidates.map((c) => ({
    trader: c.trader,
    pairId: BigInt(c.pairIndex),
    index: BigInt(c.index),
    limitOrder: LimitOrder.LIQ,
  }));
  return encodeAbiParameters([SIMPLIFIED_TRADE_ID_ARRAY, { type: 'uint256' }], [trades, BigInt(timestamp)]);
}
