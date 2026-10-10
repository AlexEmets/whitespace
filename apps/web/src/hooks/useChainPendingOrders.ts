'use client';

import { formatUnits, zeroAddress } from 'viem';
import { useBlockNumber, useReadContract, useReadContracts } from 'wagmi';
import { TRADING_ABI, TRADING_STORAGE_ABI } from '@/lib/abi';
import { TRADING_ADDRESS, TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import type { OrderSummary } from '@/lib/types';
import { useOrders } from './useOrders';

/**
 * The trader's market orders still pending ON CHAIN, shaped like the API's orders.
 *
 * Reclaiming an order the keeper never filled is the trader's only way back to their money,
 * and it used to be reachable only through /orders — i.e. only once the indexer had seen the
 * order. After the 2026-10-09 outage the indexer was two days behind while it re-indexed, so
 * two closes the keeper missed sat as "Close requested — pending keeper execution" with no
 * Release button anywhere. Reading TradingStorage directly keeps that path open whatever the
 * read side is doing.
 */
export function useChainPendingOrders(address: `0x${string}` | undefined): OrderSummary[] {
  const enabled = Boolean(address);
  const ids = useReadContract({
    address: TRADING_STORAGE_ADDRESS,
    abi: TRADING_STORAGE_ABI,
    functionName: 'getPendingOrderIds',
    args: address ? [address] : undefined,
    query: { enabled, refetchInterval: 10_000 },
  });
  const orderIds = (ids.data as readonly bigint[] | undefined) ?? [];
  const details = useReadContracts({
    contracts: orderIds.map((id) => ({
      address: TRADING_STORAGE_ADDRESS,
      abi: TRADING_STORAGE_ABI,
      functionName: 'reqID_pendingMarketOrder' as const,
      args: [id] as const,
    })),
    query: { enabled: enabled && orderIds.length > 0, refetchInterval: 10_000 },
  });
  const { data: head } = useBlockNumber({ watch: true, query: { enabled } });
  const { data: timeout } = useReadContract({ address: TRADING_ADDRESS, abi: TRADING_ABI, functionName: 'marketOrdersTimeout', query: { enabled } });

  const out: OrderSummary[] = [];
  orderIds.forEach((id, i) => {
    const r = details.data?.[i];
    if (!r || r.status !== 'success') return;
    const [block, , , trade] = r.result as readonly [bigint, bigint, number, { collateral: bigint; trader: string; leverage: number; pairIndex: number; buy: boolean }, number];
    if (trade.trader === zeroAddress) return; // resolved between the two reads
    // A close order stores the trade with leverage 0 (OstiumTrading.closeTradeMarketTimeout
    // tells the two apart the same way).
    const isClose = Number(trade.leverage) === 0;
    out.push({
      orderId: id.toString(),
      pairIndex: Number(trade.pairIndex),
      kind: isClose ? 'close' : 'open',
      buy: isClose ? null : trade.buy,
      collateral: isClose ? null : formatUnits(trade.collateral, 6),
      leverage: isClose ? null : formatUnits(BigInt(trade.leverage), 2),
      requestedAt: 0,
      requestedAtBlock: block.toString(),
      status: 'pending',
      expired: head !== undefined && timeout !== undefined && head >= block + BigInt(timeout),
      resolvedAt: null,
      cancelReason: null,
      tradeId: null,
    });
  });
  return out;
}

/**
 * The API's orders plus any market order still pending on chain that the API does not list.
 * An order the API lists stays as the API describes it; the chain only fills the gaps.
 */
export function useOrdersWithChain(address: `0x${string}` | undefined) {
  const api = useOrders(address);
  const chain = useChainPendingOrders(address);
  const known = new Set(api.orders.map((o) => o.orderId));
  const missing = chain.filter((o) => !known.has(o.orderId));
  return { ...api, orders: [...missing, ...api.orders], chainOnly: missing.length };
}
