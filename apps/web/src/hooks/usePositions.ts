'use client';

import { formatUnits } from 'viem';
import { useReadContract, useReadContracts } from 'wagmi';
import { api } from '@/lib/api';
import { TRADING_STORAGE_ABI } from '@/lib/abi';
import { DEPLOYMENT_1874, TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import type { PositionSummary } from '@/lib/types';
import { useLiveResource } from './useLiveResource';
import { useMarkets } from './useMarkets';

const REFRESH_MS = 5_000;

/**
 * Pairs to scan on-chain for the wallet's open trades, built-time deployment record as the
 * fallback. The four 1874 markets if even that has none.
 *
 * Only a fallback: a market listed after this bundle was built (e.g. XRP/USD, pairIndex 4)
 * is absent here, so `pairsToScan` below prefers the live `/markets` list. Scanning off the
 * build-time record alone silently hid positions on any newly listed market until the web
 * was rebuilt — the chain reads for the known pairs still succeeded, so the hook never even
 * fell back to the API list that did carry the new pair.
 */
const FALLBACK_PAIRS: number[] =
  ((DEPLOYMENT_1874 as unknown as { markets?: { pairIndex: number }[] }).markets ?? []).map((m) => m.pairIndex).length > 0
    ? (DEPLOYMENT_1874 as unknown as { markets: { pairIndex: number }[] }).markets.map((m) => m.pairIndex)
    : [0, 1, 2, 3];

/**
 * The pair indexes to read open trades for: the live `/markets` list when it has loaded,
 * so a newly listed market shows its positions without a rebuild; otherwise the build-time
 * fallback so the first render (before `/markets` resolves) still shows the known pairs.
 */
export function pairsToScan(markets: { pairIndex: number }[], fallback: number[] = FALLBACK_PAIRS): number[] {
  return markets.length > 0 ? markets.map((m) => m.pairIndex) : fallback;
}

type ChainTrade = { collateral: bigint; openPrice: bigint; tp: bigint; sl: bigint; leverage: number; pairIndex: number; index: number; buy: boolean };
type ChainInfo = { tradeId: bigint; createdAt: number };

/**
 * The wallet's open positions, read from TradingStorage — the API's list only as a fallback.
 *
 * The positions table used to be the indexer's view of the chain, so it was exactly as current
 * as the indexer. When the indexer fell two days behind during a re-index, a close the keeper
 * filled in three seconds still showed the position, under "Close requested — pending keeper
 * execution", for as long as the indexer took to catch up; a new position did not appear at
 * all. Open positions are a handful of storage reads, made from the trader's browser, so the
 * table now shows the chain itself and falls back to the API only if those reads fail.
 */
export function usePositions(address: `0x${string}` | undefined) {
  const enabled = Boolean(address);
  const { markets } = useMarkets();
  const PAIRS = pairsToScan(markets);
  const fromApi = useLiveResource<PositionSummary[]>({
    channel: address ? `positions:${address}` : null,
    enabled,
    pollMs: 5000,
    fetcher: () => api.positions(address as string),
    extractFromWs: (msg) => (msg.type === 'positions' ? msg.data : null),
  });

  const query = { enabled, refetchInterval: REFRESH_MS } as const;
  const max = useReadContract({ address: TRADING_STORAGE_ADDRESS, abi: TRADING_STORAGE_ABI, functionName: 'maxTradesPerPair', query: { enabled } });
  const counts = useReadContracts({
    contracts: PAIRS.map((p) => ({
      address: TRADING_STORAGE_ADDRESS,
      abi: TRADING_STORAGE_ABI,
      functionName: 'openTradesCount' as const,
      args: [address ?? '0x0000000000000000000000000000000000000000', p] as const,
    })),
    query,
  });
  const maxTrades = max.data === undefined ? 0 : Number(max.data);
  const pairsWithTrades = PAIRS.filter((_, i) => counts.data?.[i]?.status === 'success' && Number(counts.data[i]!.result) > 0);
  const slots = pairsWithTrades.flatMap((p) => Array.from({ length: maxTrades }, (_, index) => [p, index] as const));
  const trades = useReadContracts({
    contracts: slots.map(([p, index]) => ({
      address: TRADING_STORAGE_ADDRESS,
      abi: TRADING_STORAGE_ABI,
      functionName: 'getOpenTrade' as const,
      args: [address ?? '0x0000000000000000000000000000000000000000', p, index] as const,
    })),
    query: { ...query, enabled: enabled && slots.length > 0 },
  });
  const open = slots.filter((_, i) => {
    const r = trades.data?.[i];
    return r?.status === 'success' && Number((r.result as ChainTrade).leverage) > 0;
  });
  const infos = useReadContracts({
    contracts: open.map(([p, index]) => ({
      address: TRADING_STORAGE_ADDRESS,
      abi: TRADING_STORAGE_ABI,
      functionName: 'getOpenTradeInfo' as const,
      args: [address ?? '0x0000000000000000000000000000000000000000', p, index] as const,
    })),
    query: { ...query, enabled: enabled && open.length > 0 },
  });

  const countsOk = counts.data !== undefined && counts.data.every((r) => r.status === 'success') && max.data !== undefined;
  const tradesOk = slots.length === 0 || (trades.data !== undefined && trades.data.length === slots.length && trades.data.every((r) => r.status === 'success'));
  const infosOk = open.length === 0 || (infos.data !== undefined && infos.data.length === open.length && infos.data.every((r) => r.status === 'success'));
  const fromChain: PositionSummary[] | null =
    enabled && countsOk && tradesOk && infosOk
      ? open.map(([p, index]) => {
          const t = trades.data![slots.findIndex(([sp, si]) => sp === p && si === index)]!.result as ChainTrade;
          const info = infos.data![open.findIndex(([op, oi]) => op === p && oi === index)]!.result as ChainInfo;
          return {
            pairIndex: Number(t.pairIndex),
            index: Number(t.index),
            buy: t.buy,
            collateral: formatUnits(t.collateral, 6),
            leverage: formatUnits(BigInt(t.leverage), 2),
            openPrice: formatUnits(t.openPrice, 18),
            tp: formatUnits(t.tp, 18),
            sl: formatUnits(t.sl, 18),
            openedAt: Number(info.createdAt),
            tradeId: info.tradeId.toString(),
          };
        })
      : null;

  if (fromChain) {
    return { positions: fromChain, error: null, stale: false, loading: false, refetch: fromApi.refetch, source: 'chain' as const };
  }
  return { positions: fromApi.data ?? [], error: fromApi.error, stale: fromApi.stale, loading: fromApi.loading, refetch: fromApi.refetch, source: 'api' as const };
}
