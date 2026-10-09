'use client';

import { useReadContract } from 'wagmi';
import { CALLBACKS_ABI } from '@/lib/abi';
import { CALLBACKS_ADDRESS } from '@/lib/deployment';

/**
 * `OstiumTradingCallbacks.maxSl_P`: the widest stop loss, as a percent loss of margin. A stop
 * placed beyond it is not refused at open; it is silently pulled in to the boundary on fill
 * (`TradingCallbacksLib.correctSl`), so a form that does not know it shows a stop the
 * position will not have. Null until read.
 */
export function useMaxSlP(): bigint | null {
  const { data } = useReadContract({ address: CALLBACKS_ADDRESS, abi: CALLBACKS_ABI, functionName: 'maxSl_P' });
  return data === undefined ? null : BigInt(data);
}
