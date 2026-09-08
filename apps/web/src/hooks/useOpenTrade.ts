'use client';

import { parseEventLogs, zeroAddress, type Address } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { OPEN_ORDER_TYPE_MARKET, TRADING_ABI } from '@/lib/abi';
import { TRADING_ADDRESS } from '@/lib/deployment';

export interface OpenTradeParams {
  pairIndex: number;
  buy: boolean;
  /** Raw 6-decimal USDW amount. */
  collateralRaw: bigint;
  /** Raw PRECISION_2 leverage, e.g. 1000n for 10.00x. */
  leverageRaw: bigint;
  /** The price the trader saw when submitting (raw 18-decimal). Becomes `t.openPrice` —
   * the "wanted price" the contract checks the execution price against via slippageP.
   * See contracts/src/vendor/ostium/OstiumTrading.sol:198 (must be nonzero) and
   * lib/TradingCallbacksLib.sol:210-215 (the slippage check itself). */
  wantedPriceRaw: bigint;
  /** slippageP: PRECISION_2 percent, numerically identical to bps (contracts/src/vendor
   * /ostium/OstiumTrading.sol:28, `PERCENT_BASE = 100e2`, and the
   * `wantedPrice * slippageP / 100 / 100` check) — 50n means 0.50%. */
  slippageBps: bigint;
  tp?: bigint;
  sl?: bigint;
}

/** Submits `openTrade` directly against the Trading contract (wallet-signed, not through
 * the API — see the phase-5 brief). This only confirms the *request* landed on-chain;
 * the position opens or is cancelled later, when a keeper delivers the signed price
 * report (design §5.1). Callers must not treat a successful receipt here as "position
 * opened" — see components/OpenPositionForm.tsx for how the pending state is surfaced. */
export function useOpenTrade() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  async function openTrade(params: OpenTradeParams) {
    if (!address) throw new Error('useOpenTrade: wallet not connected');
    if (!publicClient) throw new Error('useOpenTrade: no public client');

    const hash = await writeContractAsync({
      address: TRADING_ADDRESS,
      abi: TRADING_ABI,
      functionName: 'openTrade',
      args: [
        {
          collateral: params.collateralRaw,
          openPrice: params.wantedPriceRaw,
          tp: params.tp ?? 0n,
          sl: params.sl ?? 0n,
          trader: address as Address,
          // viem types Trade.leverage (Solidity uint32) as `number`, not `bigint` — only
          // the wider uint192/uint256 fields above are bigint. Safe to convert here:
          // leverage is PRECISION_2 and bounded well under Number.MAX_SAFE_INTEGER (a
          // 100.00x leverage is raw 10000), so this loses no precision. The bigint stays
          // the source of truth everywhere else (money.ts, pnl.ts, display).
          leverage: Number(params.leverageRaw),
          pairIndex: params.pairIndex,
          index: 0,
          buy: params.buy,
          isDayTrade: false,
        },
        { builder: zeroAddress, builderFee: 0 },
        OPEN_ORDER_TYPE_MARKET,
        params.slippageBps,
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const events = parseEventLogs({
      abi: TRADING_ABI,
      eventName: 'MarketOpenOrderInitiated',
      logs: receipt.logs,
    });
    const orderId = events[0]?.args.orderId;

    return { hash, receipt, orderId };
  }

  return { openTrade, isPending };
}
