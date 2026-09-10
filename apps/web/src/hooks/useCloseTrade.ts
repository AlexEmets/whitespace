'use client';

import { usePublicClient, useWriteContract } from 'wagmi';
import { TRADING_ABI } from '@/lib/abi';
import { TRADING_ADDRESS } from '@/lib/deployment';
import { confirmTx } from '@/lib/tx';

/** PRECISION_2 percent, PERCENT_BASE per contracts/src/vendor/ostium/OstiumTrading.sol:28. */
export const FULL_CLOSE_PERCENT = 10000;

export interface CloseTradeParams {
  pairIndex: number;
  index: number;
  /** PRECISION_2 percent of the position to close; FULL_CLOSE_PERCENT (10000) for a full close. */
  closePercentage: number;
  /** The price the trader saw when submitting (raw 18-decimal) — same wanted-price /
   * slippage mechanism as open (see useOpenTrade.ts). */
  marketPriceRaw: bigint;
  /** slippageP, PRECISION_2 percent == bps. */
  slippageBps: bigint;
}

/** Submits `closeTradeMarket` directly against the Trading contract. Same two-phase
 * caveat as open: this only confirms the close *request*; the position is actually
 * closed once the keeper delivers the report. Per design §7, closes are allowed even in
 * degraded mode (only opens are blocked), so this hook has no degraded-mode gate. */
export function useCloseTrade() {
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  async function closeTrade(params: CloseTradeParams) {
    if (!publicClient) throw new Error('useCloseTrade: no public client');

    const hash = await writeContractAsync({
      address: TRADING_ADDRESS,
      abi: TRADING_ABI,
      functionName: 'closeTradeMarket',
      args: [params.pairIndex, params.index, params.closePercentage, params.marketPriceRaw, Number(params.slippageBps)],
    });

    const receipt = await confirmTx(publicClient, hash, 'close the position');
    return { hash, receipt };
  }

  return { closeTrade, isPending };
}
