'use client';

import { useReadContract } from 'wagmi';
import { PAIR_INFOS_ABI } from '@/lib/abi';
import { PAIR_INFOS_ADDRESS } from '@/lib/deployment';
import { fundingRatePerHourP } from '@/lib/positionMath';

/**
 * The pair's current funding rate per hour, percent at 1e18 scale (positive: longs pay
 * shorts), from `OstiumPairInfos.getPendingAccFundingFees` — the rate the accumulator is
 * moving at right now, not a forecast. Funding on this protocol is continuous per block, so
 * there is no settlement countdown to show.
 */
export function useFundingRate(pairIndex: number | null): bigint | null {
  const { data } = useReadContract({
    address: PAIR_INFOS_ADDRESS,
    abi: PAIR_INFOS_ABI,
    functionName: 'getPendingAccFundingFees',
    args: pairIndex === null ? undefined : [pairIndex],
    query: { enabled: pairIndex !== null, refetchInterval: 30_000 },
  });
  return data ? fundingRatePerHourP(BigInt(data[2])) : null;
}
