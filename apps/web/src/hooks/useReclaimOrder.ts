'use client';

import { useBlockNumber, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { TRADING_ABI } from '@/lib/abi';
import { TRADING_ADDRESS } from '@/lib/deployment';
import { confirmTx } from '@/lib/tx';
import type { OrderSummary } from '@/lib/types';

/**
 * Reclaiming the collateral behind an order the keeper never filled.
 *
 * `openTrade` takes the trader's collateral up front and emits a price request. If no
 * signed report is ever delivered — a keeper outage, a stalled oracle — the order stays
 * pending and that collateral stays locked in TradingStorage. `OstiumTrading
 * .openTradeMarketTimeout` is the way out: past `marketOrdersTimeout` blocks it
 * unregisters the order and transfers the full collateral back.
 *
 * This app had no route to it at all, so a trader whose order was orphaned had a balance
 * they could see and not touch. That happened for real here: a keeper went blind for hours
 * and left an order pending with 250 USDW behind it.
 *
 * Note the contract requires `trade.trader == msg.sender` — nobody can perform this
 * recovery on a trader's behalf, which is exactly why it has to exist in the UI.
 */
export function useReclaimOrder() {
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  /**
   * An OPEN order returns its collateral (`openTradeMarketTimeout`); a CLOSE order releases the
   * position back to the trader, still open, so it can be closed again
   * (`closeTradeMarketTimeout(order, retry=false)`). Both are gated on the same block timeout.
   */
  async function reclaim(orderId: string, kind: string = 'open'): Promise<`0x${string}`> {
    if (!publicClient) throw new Error('useReclaimOrder: no public client');
    const hash =
      kind === 'close'
        ? await writeContractAsync({
            address: TRADING_ADDRESS,
            abi: TRADING_ABI,
            functionName: 'closeTradeMarketTimeout',
            args: [BigInt(orderId), false],
          })
        : await writeContractAsync({
            address: TRADING_ADDRESS,
            abi: TRADING_ABI,
            functionName: 'openTradeMarketTimeout',
            args: [BigInt(orderId)],
          });
    await confirmTx(publicClient, hash, kind === 'close' ? 'release the timed-out close' : 'reclaim the collateral');
    return hash;
  }

  return { reclaim, isPending };
}

/**
 * Whether `order` is past the point where the contract will allow a refund.
 *
 * Compared in BLOCKS, because that is what the contract compares
 * (`block.number >= requestBlock + marketOrdersTimeout`). Inferring it from wall-clock
 * time and an assumed block interval would put the button a few seconds either side of
 * the truth, and the wrong side of it is a revert.
 */
export function useIsReclaimable(order: OrderSummary): { reclaimable: boolean; blocksRemaining: number | null } {
  const { data: head } = useBlockNumber({ watch: true });
  const { data: timeout } = useReadContract({
    address: TRADING_ADDRESS,
    abi: TRADING_ABI,
    functionName: 'marketOrdersTimeout',
  });

  const eligible =
    order.status === 'pending' && (order.kind === 'open' || order.kind === 'close') && order.requestedAtBlock !== null;
  if (!eligible || head === undefined || timeout === undefined) {
    return { reclaimable: false, blocksRemaining: null };
  }

  const unlockAt = BigInt(order.requestedAtBlock as string) + BigInt(timeout);
  if (head >= unlockAt) return { reclaimable: true, blocksRemaining: 0 };
  return { reclaimable: false, blocksRemaining: Number(unlockAt - head) };
}
