'use client';

import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
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
  const { address: account } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();

  async function closeTrade(params: CloseTradeParams) {
    if (!publicClient) throw new Error('useCloseTrade: no public client');

    // Simulated before it is sent, which is the only point at which the chain will say
    // *why* a close cannot happen. Once mined, a revert reason is not in the receipt — see
    // TransactionRevertedError — so the trader paid gas for "it reverted" and nothing more.
    //
    // This is not hypothetical: 0x8a357f2b… reverted with
    // ERC20InsufficientBalance(trader, 57243, 1000000), because closing pulled the flat
    // pairOracleFee (1.00 USDW) out of the *wallet* and a trader who had spent their balance
    // on margin had nothing left to pay it with.
    //
    // The close-bond migration removes that particular cause — the fee will come out of the
    // position instead. The simulation stays regardless: it is not specific to that revert,
    // it is what turns ANY close failure into a reason the trader can act on, for free,
    // before the wallet even opens.
    const { request } = await publicClient.simulateContract({
      account,
      address: TRADING_ADDRESS,
      abi: TRADING_ABI,
      functionName: 'closeTradeMarket',
      args: [params.pairIndex, params.index, params.closePercentage, params.marketPriceRaw, Number(params.slippageBps)],
    });

    const hash = await writeContractAsync(request);

    const receipt = await confirmTx(publicClient, hash, 'close the position');
    return { hash, receipt };
  }

  return { closeTrade, isPending };
}
