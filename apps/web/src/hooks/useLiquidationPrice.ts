'use client';

import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { PAIR_INFOS_ABI } from '@/lib/abi';
import { PAIR_INFOS_ADDRESS } from '@/lib/deployment';

/**
 * Liquidation price, read from the contract rather than recomputed here.
 *
 * Both the positions table and the order form used to show an em-dash with the note
 * "requires on-chain funding/rollover state this app does not currently read". That was
 * true of the app, not of the chain: `OstiumPairInfos` exposes the number directly, and
 * liquidation price is the single figure a leveraged trader most needs. Reimplementing
 * the formula in TypeScript was never the alternative — a liquidation price that is
 * subtly wrong is worse than one that is absent, which is why the dash was there.
 *
 * Returns `null` (not 0n, not a guess) whenever any input is missing or the read has not
 * resolved. Callers render the dash for null.
 */

/**
 * For a position that already exists. The contract reads that specific trade's stored
 * funding accumulator and accrued rollover, so `trader`/`pairIndex`/`index` must identify
 * a real open trade — the answer is not transferable between slots.
 */
export function useLiquidationPrice(params: {
  trader: Address | undefined;
  pairIndex: number;
  index: number;
  /** Raw PRECISION_18 open price. */
  openPriceRaw: bigint;
  long: boolean;
  /** Raw PRECISION_6 collateral. */
  collateralRaw: bigint;
  /** Raw PRECISION_2 leverage, e.g. 1000n for 10.00x. */
  leverageRaw: bigint;
  /** Raw PRECISION_2 max leverage for the pair, e.g. 10000n for 100.00x. */
  maxLeverageRaw: bigint;
}): bigint | null {
  const enabled =
    Boolean(params.trader) && params.openPriceRaw > 0n && params.collateralRaw > 0n && params.leverageRaw > 0n && params.maxLeverageRaw > 0n;

  const { data } = useReadContract({
    address: PAIR_INFOS_ADDRESS,
    abi: PAIR_INFOS_ABI,
    functionName: 'getTradeLiquidationPrice',
    args: enabled
      ? [
          params.trader as Address,
          params.pairIndex,
          params.index,
          params.openPriceRaw,
          params.long,
          params.collateralRaw,
          // uint32/uint8 parameters are `number` in viem's encoder, not bigint (same
          // boundary useOpenTrade.ts and useMarketFees.ts document). Both are PRECISION_2
          // and bounded far below Number.MAX_SAFE_INTEGER, so the narrowing is exact.
          Number(params.leverageRaw),
          Number(params.maxLeverageRaw),
        ]
      : undefined,
    query: { enabled },
  });

  // Gated on `enabled`, not just on `data`. wagmi keeps the last successful result in its
  // query cache, so a read that becomes disabled again (the trader clears the size field,
  // the price feed drops out) would otherwise keep rendering the previous answer as though
  // it still applied to the current inputs.
  return enabled ? (data ?? null) : null;
}

/**
 * For a position that does not exist yet — the order form's estimate.
 *
 * Rollover and funding are passed as 0: a trade opened this instant has accrued neither.
 * That makes this the contract's own formula evaluated at t=0, which is precisely what
 * "estimated liquidation price at open" means. It will drift once the position is live
 * and starts paying rollover, which is why the positions table uses the other function
 * rather than this one.
 */
export function useEstimatedLiquidationPrice(params: {
  /** Raw PRECISION_18 price the order would open at (the current mark). */
  openPriceRaw: bigint;
  long: boolean;
  collateralRaw: bigint;
  leverageRaw: bigint;
  maxLeverageRaw: bigint;
}): bigint | null {
  const enabled = params.openPriceRaw > 0n && params.collateralRaw > 0n && params.leverageRaw > 0n && params.maxLeverageRaw > 0n;

  const { data } = useReadContract({
    address: PAIR_INFOS_ADDRESS,
    abi: PAIR_INFOS_ABI,
    functionName: 'getTradeLiquidationPricePure',
    args: enabled
      ? [params.openPriceRaw, params.long, params.collateralRaw, Number(params.leverageRaw), 0n, 0n, Number(params.maxLeverageRaw)]
      : undefined,
    query: { enabled },
  });

  // Gated on `enabled`, not just on `data`. wagmi keeps the last successful result in its
  // query cache, so a read that becomes disabled again (the trader clears the size field,
  // the price feed drops out) would otherwise keep rendering the previous answer as though
  // it still applied to the current inputs.
  return enabled ? (data ?? null) : null;
}
