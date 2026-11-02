'use client';

import { useMemo } from 'react';
import { useAccount, useReadContracts } from 'wagmi';
import { PAIR_INFOS_ABI } from '@/lib/abi';
import { PAIR_INFOS_ADDRESS } from '@/lib/deployment';
import { collateralToRaw, leverageToRaw, priceToRaw } from '@/lib/money';
import { positionLevels, type PositionLevel } from '@/lib/positionLevels';
import { liquidationPriceArgs } from './useLiquidationPrice';
import { useMarkets } from './useMarkets';
import { usePositions } from './usePositions';

/**
 * The connected wallet's levels on one market — entry, TP, SL and liquidation for each of
 * its open positions there — for the price chart to draw. Liquidation prices are read from
 * the contract in one batch, the same question the positions table asks one trade at a
 * time (see liquidationPriceArgs); a read that fails or has not landed leaves that level
 * off rather than standing in a guess.
 */
export function usePositionLevels(pairIndex: number | null): PositionLevel[] {
  const { address } = useAccount();
  const { positions } = usePositions(address);
  const { markets } = useMarkets();

  const mine = useMemo(
    () => (address && pairIndex !== null ? positions.filter((p) => p.pairIndex === pairIndex) : []),
    [address, pairIndex, positions],
  );
  const maxLeverage = markets.find((m) => m.pairIndex === pairIndex)?.maxLeverage;

  const reads = useMemo(
    () =>
      mine.flatMap((p) => {
        const args = liquidationPriceArgs({
          trader: address,
          pairIndex: p.pairIndex,
          index: p.index,
          openPriceRaw: priceToRaw(p.openPrice),
          long: p.buy,
          collateralRaw: collateralToRaw(p.collateral),
          leverageRaw: leverageToRaw(p.leverage),
          maxLeverageRaw: maxLeverage ? leverageToRaw(maxLeverage) : 0n,
        });
        return args ? [{ key: `${p.pairIndex}:${p.index}`, args }] : [];
      }),
    [mine, address, maxLeverage],
  );

  const { data } = useReadContracts({
    contracts: reads.map((r) => ({
      address: PAIR_INFOS_ADDRESS,
      abi: PAIR_INFOS_ABI,
      functionName: 'getTradeLiquidationPrice' as const,
      args: r.args,
    })),
    query: { enabled: reads.length > 0, refetchInterval: 30_000 },
  });

  return useMemo(() => {
    const liqByTrade = new Map<string, bigint>();
    reads.forEach((r, i) => {
      const answer = data?.[i];
      if (answer?.status === 'success' && typeof answer.result === 'bigint') liqByTrade.set(r.key, answer.result);
    });
    return mine.flatMap((p) => positionLevels(p, liqByTrade.get(`${p.pairIndex}:${p.index}`) ?? null));
  }, [mine, reads, data]);
}
