'use client';

import { useReadContract } from 'wagmi';
import { PAIRS_STORAGE_ABI, PAIR_INFOS_ABI } from '@/lib/abi';
import { PAIRS_STORAGE_ADDRESS, PAIR_INFOS_ADDRESS } from '@/lib/deployment';

/**
 * Real fee figures read directly from the chain, not the design mockup's numbers. The
 * read API (D3) does not expose a fee field, so this goes straight to
 * `IOstiumPairInfos.pairOpeningFees` (maker/taker %, PRECISION_6) and
 * `IOstiumPairsStorage.pairOracleFee` (flat USDC fee per order, PRECISION_6) — the exact
 * values contracts/src/vendor/ostium/OstiumTrading.sol charges. No wallet connection is
 * required; these are public reads against the configured chain.
 */
export function useMarketFees(pairIndex: number | null) {
  const openingFees = useReadContract({
    address: PAIR_INFOS_ADDRESS,
    abi: PAIR_INFOS_ABI,
    functionName: 'pairOpeningFees',
    args: pairIndex === null ? undefined : [pairIndex],
    query: { enabled: pairIndex !== null },
  });

  const oracleFee = useReadContract({
    address: PAIRS_STORAGE_ADDRESS,
    abi: PAIRS_STORAGE_ABI,
    functionName: 'pairOracleFee',
    args: pairIndex === null ? undefined : [pairIndex],
    query: { enabled: pairIndex !== null },
  });

  // The pair's smallest collateral × leverage once fees are out — below it `openTrade`
  // reverts BelowMinLevPos (TradingLib.getOpenTradeRevert). uint64, so already a bigint.
  const minLevPos = useReadContract({
    address: PAIRS_STORAGE_ADDRESS,
    abi: PAIRS_STORAGE_ABI,
    functionName: 'pairMinLevPos',
    args: pairIndex === null ? undefined : [pairIndex],
    query: { enabled: pairIndex !== null },
  });

  // viem types Solidity uint32/uint16/uint8 return values as JS `number`, not `bigint`
  // (only the wider uint64/uint192/uint256 fields decode to bigint — see the same note
  // in useOpenTrade.ts). makerFeeP/takerFeeP here are uint32, so they arrive as `number`
  // and must be converted to bigint at this exact boundary before touching
  // src/lib/money.ts — passing the raw `number` through was caught immediately by
  // money.ts's runtime guard (MoneyTypeError) the first time this hook was wired up.
  const openingFeesData = openingFees.data;
  const makerFeeRaw = openingFeesData ? BigInt(openingFeesData[0]) : null;
  const takerFeeRaw = openingFeesData ? BigInt(openingFeesData[1]) : null;

  return {
    // PRECISION_6 percent — format with src/lib/money.ts at 6 decimals, e.g.
    // formatMoney(makerFeeRaw, 6) => "0.035" for 0.035%.
    makerFeeRaw,
    takerFeeRaw,
    // PRECISION_6 USDC flat fee. pairOracleFee is uint64 -> already bigint.
    oracleFeeRaw: oracleFee.data ?? null,
    // PRECISION_6 USDW.
    minLevPosRaw: minLevPos.data ?? null,
    loading: openingFees.isLoading || oracleFee.isLoading,
  };
}
