'use client';

import { parseEventLogs, zeroAddress, type Address, type Hash, type TransactionReceipt } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { OPEN_ORDER_TYPE, TRADING_ABI, type OpenOrderKind } from '@/lib/abi';
import { slippageForSubmission } from '@/lib/orderRules';
import { TRADING_ADDRESS } from '@/lib/deployment';
import { padGas } from '@/lib/gas';
import { confirmTx } from '@/lib/tx';
import { useSessionKey } from './useSessionKey';

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
  /** MARKET fills at the next report; LIMIT/STOP rest until the automation bot triggers them,
   * with `wantedPriceRaw` as the trigger. Defaults to MARKET. */
  kind?: OpenOrderKind;
}

/** Submits `openTrade` (MARKET, LIMIT or STOP) directly against the Trading contract (wallet-signed, not through
 * the API — see the phase-5 brief). This only confirms the *request* landed on-chain;
 * the position opens or is cancelled later, when a keeper delivers the signed price
 * report (design §5.1). Callers must not treat a successful receipt here as "position
 * opened" — see components/OpenPositionForm.tsx for how the pending state is surfaced. */
export function useOpenTrade() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();
  const session = useSessionKey();

  async function openTrade(params: OpenTradeParams) {
    if (!address) throw new Error('useOpenTrade: wallet not connected');
    if (!publicClient) throw new Error('useOpenTrade: no public client');
    const kind = params.kind ?? 'MARKET';
    const describe = kind === 'MARKET' ? 'open the position' : 'place the order';

    const args = [
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
      OPEN_ORDER_TYPE[kind],
      // The contract requires 0 for LIMIT/STOP and (0, 100e2) for MARKET (openTrade).
      slippageForSubmission(kind, params.slippageBps),
    ] as const;

    // With one-click trading on, the session key signs this locally (no popup) via
    // delegatedAction; otherwise it is a normal wallet-signed write. Both land the same
    // openTrade against the same contract and emit the same events, so the parsing below is shared.
    let hash: Hash;
    let receipt: TransactionReceipt;
    if (session.active) {
      ({ hash, receipt } = await session.send('openTrade', args, describe));
    } else {
      const request = {
        account: address as Address,
        address: TRADING_ADDRESS,
        abi: TRADING_ABI,
        functionName: 'openTrade',
        args,
      } as const;
      hash = await writeContractAsync(await padGas(publicClient, request as never));
      receipt = await confirmTx(publicClient, hash, describe);
    }

    if (kind !== 'MARKET') {
      const placed = parseEventLogs({ abi: TRADING_ABI, eventName: 'OpenLimitPlacedV2', logs: receipt.logs });
      return { hash, receipt, orderId: undefined, limitIndex: placed[0]?.args.index };
    }
    const events = parseEventLogs({
      abi: TRADING_ABI,
      eventName: 'MarketOpenOrderInitiated',
      logs: receipt.logs,
    });
    const orderId = events[0]?.args.orderId;

    return { hash, receipt, orderId, limitIndex: undefined };
  }

  return { openTrade, isPending };
}
