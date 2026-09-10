'use client';

import { parseAbi } from 'viem';
import { useReadContracts } from 'wagmi';
import { TRADING_ABI } from '@/lib/abi';
import { DEPLOYMENT_1874, PAIR_INFOS_ADDRESS, TRADING_ADDRESS } from '@/lib/deployment';

/**
 * Every protocol constant the docs page quotes, read live from the deployed contracts
 * rather than transcribed from a document.
 *
 * This exists because the repo's own documents disagree about what is actually running.
 * The design spec and the phase-2 record both state "k=3 of N=5, maxAge 10 s,
 * maxDeviationBps 500" — but phase-2's retrospective closes with "**Nothing was
 * deployed.**", and phase-3 records the live verifier as still being the old 1-of-N
 * contract. `deployments/1874.json` then supersedes both with a `phase-A oracle migration`
 * block naming a new verifier and upkeep. Three documents, three answers about what is
 * protecting a trader's money right now.
 *
 * A docs page cannot resolve that by picking a favourite, so it asks the chain. Every
 * value below is a `view` call against the addresses in `deployments/1874.json`. A call
 * that fails leaves its value `null` and the page renders a dash — "we could not read it"
 * and "it is 3" are different statements, and only one of them is safe to print under the
 * heading "security".
 *
 * No wallet connection is required; these are public reads, the same pattern
 * `useMarketFees` uses for fees.
 */

// source: contracts/src/oracle/WhitespaceVerifier.sol:62,65 — `uint256 public signerCount`
// and `uint256 public threshold`, both auto-generated public getters.
const VERIFIER_ABI = parseAbi([
  'function threshold() view returns (uint256)',
  'function signerCount() view returns (uint256)',
]);

// source: contracts/src/oracle/WhitespacePriceUpKeep.sol:79,80 — `uint32 public maxAge`
// and `uint16 public maxDeviationBps`.
const PRICE_UPKEEP_ABI = parseAbi([
  'function maxAge() view returns (uint32)',
  'function maxDeviationBps() view returns (uint16)',
]);

// source: OstiumPairInfos.sol — `liqMarginThresholdP` is the governance-mutable percentage
// in the liquidation predicate (docs/decisions/phase-6-liquidator.md §2.1/§2.4).
const PAIR_INFOS_RISK_ABI = parseAbi(['function liqMarginThresholdP() view returns (uint8)']);

/**
 * The canonical Multicall3 deployment, verified present on 1874 (7,619 bytes of code;
 * `getBlockNumber()` answers). It is passed explicitly because `wagmiConfig`'s chain
 * definition does not declare a `contracts.multicall3` entry, and without an address viem
 * would fall back to one HTTP request per call.
 *
 * That fallback is not merely slower, it is the difference between this page working and
 * not. The public RPC rate-limits under burst, and a throttled response comes back without
 * CORS headers — so the browser reports it as a CORS failure. Worse, each failure is then
 * retried by viem's transport *and* by TanStack Query, multiplying one refused request
 * into roughly sixteen. Six independent reads reliably tripped that cascade and filled the
 * console with ~192 errors; one multicall does not.
 */
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export interface ProtocolParams {
  /** k — signatures required over one price report. */
  threshold: bigint | null;
  /** N — authorised signers in the set. */
  signerCount: bigint | null;
  /** Seconds a signed report stays deliverable on-chain. */
  maxAgeSeconds: number | null;
  /** Basis points a new price may move from the last accepted one. */
  maxDeviationBps: number | null;
  /** Blocks before an unfilled market order can be reclaimed by the trader. */
  marketOrdersTimeoutBlocks: number | null;
  /** Percentage in the liquidation margin predicate. */
  liqMarginThresholdP: number | null;
  loading: boolean;
}

export function useProtocolParams(): ProtocolParams {
  const { verifier, priceUpKeep } = DEPLOYMENT_1874.contracts;

  const { data, isLoading } = useReadContracts({
    // `allowFailure` keeps one unreadable parameter from blanking the other five: each
    // entry resolves independently, and only the ones that failed become dashes.
    allowFailure: true,
    multicallAddress: MULTICALL3_ADDRESS,
    contracts: [
      { address: verifier, abi: VERIFIER_ABI, functionName: 'threshold' },
      { address: verifier, abi: VERIFIER_ABI, functionName: 'signerCount' },
      { address: priceUpKeep, abi: PRICE_UPKEEP_ABI, functionName: 'maxAge' },
      { address: priceUpKeep, abi: PRICE_UPKEEP_ABI, functionName: 'maxDeviationBps' },
      { address: TRADING_ADDRESS, abi: TRADING_ABI, functionName: 'marketOrdersTimeout' },
      { address: PAIR_INFOS_ADDRESS, abi: PAIR_INFOS_RISK_ABI, functionName: 'liqMarginThresholdP' },
    ],
    // These are deployment constants, not prices: read once per page load. A retry budget
    // of one keeps a throttled RPC from turning a single refusal into a retry storm.
    query: { retry: 1, staleTime: 60_000, refetchOnWindowFocus: false },
  });

  const value = <T,>(index: number): T | null => {
    const entry = data?.[index];
    return entry?.status === 'success' ? (entry.result as T) : null;
  };

  return {
    threshold: value<bigint>(0),
    signerCount: value<bigint>(1),
    // viem decodes uint8/uint16/uint32 to JS `number`, not bigint (the same boundary note
    // as useMarketFees.ts). These are counts, durations and percentages — never money —
    // so `number` is correct here; nothing this hook returns is handed to src/lib/money.ts.
    maxAgeSeconds: value<number>(2),
    maxDeviationBps: value<number>(3),
    marketOrdersTimeoutBlocks: value<number>(4),
    liqMarginThresholdP: value<number>(5),
    loading: isLoading,
  };
}
