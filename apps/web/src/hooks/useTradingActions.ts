'use client';

import { useState } from 'react';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { TRADING_ABI } from '@/lib/abi';
import { TRADING_ADDRESS } from '@/lib/deployment';
import { padGas } from '@/lib/gas';
import { confirmTx } from '@/lib/tx';

type TradingWrite =
  | { functionName: 'updateTp'; args: readonly [number, number, bigint] }
  | { functionName: 'updateSl'; args: readonly [number, number, bigint] }
  | { functionName: 'topUpCollateral'; args: readonly [number, number, bigint] }
  | { functionName: 'removeCollateral'; args: readonly [number, number, bigint] }
  | { functionName: 'updateOpenLimitOrder'; args: readonly [number, number, bigint, bigint, bigint] }
  | { functionName: 'cancelOpenLimitOrder'; args: readonly [number, number] }
  | { functionName: 'closeTradeMarketTimeout'; args: readonly [bigint, boolean] };

const ACTION_LABEL: Record<TradingWrite['functionName'], string> = {
  updateTp: 'update the take profit',
  updateSl: 'update the stop loss',
  topUpCollateral: 'add margin',
  removeCollateral: 'remove margin',
  updateOpenLimitOrder: 'update the order',
  cancelOpenLimitOrder: 'cancel the order',
  closeTradeMarketTimeout: 'reclaim the timed-out close',
};

/**
 * Every position- and order-management write the terminal makes, each simulated before the
 * wallet opens (the only point at which the chain says *why* it would fail — see
 * useCloseTrade.ts) and confirmed against the receipt status (lib/tx.ts).
 *
 * `topUpCollateral` pulls USDW through TradingStorage, the same allowance the order form
 * arms, so callers must have granted it first (useErc20(TRADING_STORAGE_ADDRESS)).
 * `removeCollateral` is two-phase like a close: this confirms the request, and a keeper's
 * report executes or rejects it.
 */
export function useTradingActions() {
  const publicClient = usePublicClient();
  const { address: account } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [pending, setPending] = useState<TradingWrite['functionName'] | null>(null);

  async function send(call: TradingWrite) {
    if (!publicClient) throw new Error('useTradingActions: no public client');
    setPending(call.functionName);
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address: TRADING_ADDRESS,
        abi: TRADING_ABI,
        functionName: call.functionName,
        // The union above pins each function to its own argument tuple.
        args: call.args as never,
      });
      const hash = await writeContractAsync(await padGas(publicClient, request as never));
      return await confirmTx(publicClient, hash, ACTION_LABEL[call.functionName]);
    } finally {
      setPending(null);
    }
  }

  return {
    pending,
    updateTp: (pairIndex: number, index: number, tp: bigint) =>
      send({ functionName: 'updateTp', args: [pairIndex, index, tp] }),
    updateSl: (pairIndex: number, index: number, sl: bigint) =>
      send({ functionName: 'updateSl', args: [pairIndex, index, sl] }),
    topUpCollateral: (pairIndex: number, index: number, amount: bigint) =>
      send({ functionName: 'topUpCollateral', args: [pairIndex, index, amount] }),
    removeCollateral: (pairIndex: number, index: number, amount: bigint) =>
      send({ functionName: 'removeCollateral', args: [pairIndex, index, amount] }),
    updateLimitOrder: (pairIndex: number, index: number, price: bigint, tp: bigint, sl: bigint) =>
      send({ functionName: 'updateOpenLimitOrder', args: [pairIndex, index, price, tp, sl] }),
    cancelLimitOrder: (pairIndex: number, index: number) =>
      send({ functionName: 'cancelOpenLimitOrder', args: [pairIndex, index] }),
    reclaimTimedOutClose: (orderId: bigint) =>
      send({ functionName: 'closeTradeMarketTimeout', args: [orderId, false] }),
  };
}
