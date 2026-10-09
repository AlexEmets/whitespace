'use client';

import { useReadContracts } from 'wagmi';
import { PAIRS_STORAGE_ABI, TRADING_STORAGE_ABI } from '@/lib/abi';
import { PAIRS_STORAGE_ADDRESS, TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import type { ExposureState } from '@/lib/orderRules';

/**
 * The live open-interest and group-collateral figures `withinExposureLimits` checks at fill,
 * read from the chain rather than the indexer so they are in the contract's own units. Null
 * until every read has answered — a partial set would check against an invented zero.
 */
export function useExposure(pairIndex: number | null): ExposureState | null {
  const enabled = pairIndex !== null;
  const pair = pairIndex ?? 0;
  const { data } = useReadContracts({
    contracts: [
      { address: TRADING_STORAGE_ADDRESS, abi: TRADING_STORAGE_ABI, functionName: 'openInterest', args: [pair, 0n] },
      { address: TRADING_STORAGE_ADDRESS, abi: TRADING_STORAGE_ABI, functionName: 'openInterest', args: [pair, 1n] },
      { address: TRADING_STORAGE_ADDRESS, abi: TRADING_STORAGE_ABI, functionName: 'openInterest', args: [pair, 2n] },
      { address: PAIRS_STORAGE_ADDRESS, abi: PAIRS_STORAGE_ABI, functionName: 'groupCollateral', args: [pair, true] },
      { address: PAIRS_STORAGE_ADDRESS, abi: PAIRS_STORAGE_ABI, functionName: 'groupCollateral', args: [pair, false] },
      { address: PAIRS_STORAGE_ADDRESS, abi: PAIRS_STORAGE_ABI, functionName: 'groupMaxCollateral', args: [pair] },
    ],
    query: { enabled, refetchInterval: 15_000, retry: 1, refetchOnWindowFocus: false },
  });
  if (!enabled || !data || data.some((r) => r.status !== 'success')) return null;
  const [longOi, shortOi, oiCap, groupCollateralLong, groupCollateralShort, groupMaxCollateral] = data.map(
    (r) => r.result as bigint,
  );
  return { longOi: longOi!, shortOi: shortOi!, oiCap: oiCap!, groupCollateralLong: groupCollateralLong!, groupCollateralShort: groupCollateralShort!, groupMaxCollateral: groupMaxCollateral! };
}
