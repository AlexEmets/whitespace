'use client';

import { useMemo } from 'react';
import { useBlock, useReadContracts } from 'wagmi';
import { PAIR_INFOS_IMPACT_ABI } from '@/lib/abiPairInfos';
import { PAIR_INFOS_ADDRESS } from '@/lib/deployment';
import { priceToRaw } from '@/lib/money';
import type { LadderInputs } from '@/lib/priceImpact';
import { quoteForNotional, type Quote } from '@/lib/quote';
import { usePrice } from './usePrice';

/** Every distinct reason the quote can be unavailable. The panel prints them verbatim
 * — a trader (or the next developer) should be able to tell which input is missing
 * without opening a console. */
export type QuoteUnavailableReason =
  | { kind: 'no-price'; detail: string }
  | { kind: 'no-quote'; detail: string }
  | { kind: 'read-failed'; detail: string }
  | { kind: 'inconsistent-read'; detail: string };

/** Raw on-chain inputs, surfaced so the panel can show what it actually read. */
export interface QuoteChainState {
  priceImpactK: bigint;
  netVolThreshold: bigint;
  decayRate: bigint;
  buyVolume: bigint;
  sellVolume: bigint;
  lastUpdateTimestamp: bigint;
  blockTimestamp: bigint;
}

export interface QuoteInputsResult {
  loading: boolean;
  /** Null when `unavailable` is non-empty — never a partial or invented input set. */
  inputs: LadderInputs | null;
  /** Empty means the quote is real. Non-empty means nothing is rendered but the reasons. */
  unavailable: QuoteUnavailableReason[];
  /**
   * 1e18 mark price the quote is measured against, or null. This is the contract's `price`
   * argument, not a display choice: services/price-publisher/src/engine.mjs signs
   * `price: mark` (the EMA) into the report, with `bid`/`ask` set from the aggregate's
   * indexBid/indexAsk. Centring on `index` instead would measure the quote against a number
   * the contract never sees.
   */
  markRaw: bigint | null;
  /** 1e18 oracle ask/bid — the contract's `a.ask` / `a.bid`. Null when not quoted. */
  askRaw: bigint | null;
  bidRaw: bigint | null;
  /** Publisher health, passed straight through from `usePrice` — not hidden. */
  degraded: boolean;
  /** Which source answered `/price/:pairIndex`; `chain` means a frozen settled report. */
  source: 'publisher' | 'chain' | null;
  chain: QuoteChainState | null;
  /**
   * Whether the oracle published a two-sided quote. The contract's fill price is built
   * from `ask`/`bid` on BOTH code paths — the spread term of the dynamic formula, and the
   * entire answer on the static one — so without them there is no fill price to show.
   *
   * The mark is NEVER substituted for a missing side. "The spread is zero" and "the spread
   * is unknown" price a fill differently, and collapsing them would quietly turn an unknown
   * into a favourable-looking number. When this is false the panel says which side is
   * missing and renders no rows at all.
   */
  spreadAvailable: boolean;
  /**
   * True when `priceImpactK == 0`, i.e. every row came from the contract's static spread
   * path and is therefore identical at every size. Not an error — it is what this pair
   * really does — but the panel must say so, or a size-independent quote reads as a bug.
   */
  staticOnly: boolean;
}

/**
 * Live inputs to the vault's fill formula for a pair: the on-chain dynamic-spread parameters from
 * `IOstiumPairInfos`, evaluated against the live mark by src/lib/priceImpact.ts.
 *
 * Recomputes whenever the mark moves (`usePrice` polls every 3s and takes WS pushes), and
 * re-reads the chain state every 60s — the pair parameters only change by governance, and
 * the accumulated volumes only by a trade, so a tighter cadence would just burn the
 * testnet RPC's rate limit (it answers 429 under load) for nothing.
 *
 * Returns NOTHING rather than something plausible when an input is missing. That is the
 * point of the `unavailable` list: the previous version of this panel was left empty on
 * purpose because a wrong price-impact number is the exact bug class this app's
 * bigint/decimal rules exist to prevent, and shipping a guessed quote would have been
 * strictly worse than the empty state it replaced.
 */
export function useQuoteInputs(pairIndex: number | null): QuoteInputsResult {
  const price = usePrice(pairIndex);

  const enabled = pairIndex !== null;
  const args = [pairIndex ?? 0] as const;

  // `retry: 1` and the slow interval are not arbitrary: the public Whitechain testnet RPC
  // rate-limits, and a 429 there comes back without CORS headers, so the browser surfaces
  // it as a console CORS error. viem's http transport already retries each call 3x, and
  // this read fans out to 3 eth_calls (the chain has no multicall3, so @wagmi/core falls
  // back to individual calls) — leaving TanStack's default 3 retries on top multiplies one
  // failure into dozens of requests and keeps the endpoint throttled.
  const readQuery = { enabled, refetchInterval: 60_000, retry: 1, refetchOnWindowFocus: false } as const;

  const reads = useReadContracts({
    contracts: [
      { address: PAIR_INFOS_ADDRESS, abi: PAIR_INFOS_IMPACT_ABI, functionName: 'getPairPriceImpactK', args },
      { address: PAIR_INFOS_ADDRESS, abi: PAIR_INFOS_IMPACT_ABI, functionName: 'pairDynamicSpreadParams', args },
      { address: PAIR_INFOS_ADDRESS, abi: PAIR_INFOS_IMPACT_ABI, functionName: 'pairDynamicSpreadState', args },
    ],
    query: readQuery,
  });

  const [kRead, paramsRead, stateRead] = reads.data ?? [];

  // The decay is evaluated against CHAIN time, not the browser clock: the contract decays
  // `initialVolume` by `block.timestamp - lastUpdateTimestamp`, and a client whose clock is
  // minutes off would silently over- or under-decay it. A minute of staleness on the block
  // itself is immaterial next to that, hence the same slow interval.
  //
  // Only fetched when the decay can actually change a number. `_decayVolumeWithPade` with
  // `decayRate == 0` gives multiplier (1e18-0)/(1e18+0) = 1e18, i.e. the volume unchanged
  // for ANY dt, and a zero volume stays zero — so skipping the block read in those cases is
  // exact, not an approximation, and it keeps a whole eth_getBlockByNumber (plus viem's
  // retries on it) off a testnet RPC that rate-limits. On this deployment decayRate is 0,
  // so this read never fires at all.
  const decayMatters =
    paramsRead?.status === 'success' &&
    stateRead?.status === 'success' &&
    paramsRead.result[1] > 0n &&
    (stateRead.result[0] > 0n || stateRead.result[1] > 0n);

  const block = useBlock({ query: { ...readQuery, enabled: enabled && decayMatters } });

  const loading = price.loading || reads.isLoading || (decayMatters && block.isLoading);
  const unavailable: QuoteUnavailableReason[] = [];

  const markString = price.data?.mark ?? null;
  const markRaw = markString === null ? null : priceToRaw(markString);
  if (markRaw === null) {
    unavailable.push({
      kind: 'no-price',
      detail: price.error
        ? `GET /price/${pairIndex ?? '?'} failed: ${price.error}`
        : `no mark price published for pair ${pairIndex ?? '?'} yet`,
    });
  } else if (markRaw <= 0n) {
    unavailable.push({ kind: 'no-price', detail: `mark price is ${markString}` });
  }

  // The two-sided quote. Both sides are `string | null` human decimals; null is a real
  // state (the `source: 'chain'` fallback is one settled price, not a book) and must not be
  // papered over with the mark.
  const askString = price.data?.ask ?? null;
  const bidString = price.data?.bid ?? null;
  const askRaw = askString === null ? null : priceToRaw(askString);
  const bidRaw = bidString === null ? null : priceToRaw(bidString);
  const source = price.data?.source ?? null;

  if (askRaw === null || bidRaw === null) {
    const missing = askRaw === null && bidRaw === null ? 'ask and bid' : askRaw === null ? 'ask' : 'bid';
    unavailable.push({
      kind: 'no-quote',
      detail:
        `GET /price/${pairIndex ?? '?'} published no ${missing}` +
        (source === 'chain'
          ? ' — the price is the last settled on-chain report, which carries one price and no two-sided quote'
          : ' — the publisher has no two-sided aggregate right now') +
        '. The contract fills at the oracle ask or bid, so there is no fill price to quote without it.',
    });
  } else if (askRaw < bidRaw) {
    unavailable.push({
      kind: 'no-quote',
      detail: `crossed quote: ask ${askString} is below bid ${bidString} — refusing to price a fill against it`,
    });
  }

  // Two distinct failure shapes, and both have to be surfaced. A per-call revert lands in
  // `data[i].status === 'failure'`; a transport failure (RPC down, rate-limited, CORS)
  // never produces `data` at all and only sets `reads.error`. Missing the second one is how
  // a panel ends up rendering "unavailable" with no reason under it.
  const readError =
    reads.error ??
    (decayMatters ? block.error : null) ??
    (kRead?.status === 'failure'
      ? kRead.error
      : paramsRead?.status === 'failure'
        ? paramsRead.error
        : stateRead?.status === 'failure'
          ? stateRead.error
          : null);

  let chain: QuoteChainState | null = null;
  if (readError) {
    unavailable.push({
      kind: 'read-failed',
      detail: `pairInfos ${PAIR_INFOS_ADDRESS} could not be read: ${readError.message.split('\n')[0]}`,
    });
  } else if (
    kRead?.status === 'success' &&
    paramsRead?.status === 'success' &&
    stateRead?.status === 'success' &&
    (!decayMatters || block.data)
  ) {
    const priceImpactK = kRead.result;
    const [netVolThreshold, decayRate, paramsK] = paramsRead.result;
    const [buyVolume, sellVolume, lastUpdateTimestamp] = stateRead.result;

    if (paramsK !== priceImpactK) {
      // Free cross-check that the struct tuple is being decoded in the declared order:
      // `getPairPriceImpactK` returns `pairDynamicSpreadParams[pairIndex].priceImpactK`, so
      // the two reads are the same storage slot by two routes. If they disagree, the ABI is
      // wrong and every number downstream would be wrong too — refuse rather than render.
      unavailable.push({
        kind: 'inconsistent-read',
        detail:
          `getPairPriceImpactK returned ${priceImpactK} but pairDynamicSpreadParams.priceImpactK ` +
          `returned ${paramsK} — the ABI tuple order cannot be trusted`,
      });
    }

    chain = {
      priceImpactK,
      netVolThreshold,
      decayRate,
      buyVolume,
      sellVolume,
      // viem decodes uint32 as a JS number (uint56 and wider become bigint); widen it here,
      // at the decode boundary, so nothing downstream ever sees a `number`.
      lastUpdateTimestamp: BigInt(lastUpdateTimestamp),
      // dt = 0 when the decay is a no-op (see `decayMatters`) — exact, not a stand-in.
      blockTimestamp: block.data?.timestamp ?? BigInt(lastUpdateTimestamp),
    };

    // priceImpactK == 0 is deliberately NOT an unavailable reason. The contract still has a
    // definite answer in that case — `getDynamicTradePriceImpact` falls through to
    // `_getTradePriceImpact` and fills at the oracle ask/bid — so the honest rendering is a
    // working, size-independent quote plus a note, not an empty panel. See `staticOnly`.
  }

  if (!loading && !chain && unavailable.length === 0) {
    // Belt and braces: the notice must never render with an empty reason list. If the reads
    // settled into some state not enumerated above, say that rather than showing a blank.
    unavailable.push({
      kind: 'read-failed',
      detail: `pairInfos ${PAIR_INFOS_ADDRESS} returned no data for pair ${pairIndex ?? '?'}`,
    });
  }

  const common = {
    markRaw,
    askRaw,
    bidRaw,
    degraded: price.data?.degraded ?? false,
    source,
    chain,
    spreadAvailable: askRaw !== null && bidRaw !== null,
    staticOnly: chain?.priceImpactK === 0n,
  };

  if (loading || !chain) {
    return { ...common, loading, inputs: null, unavailable: loading ? [] : unavailable };
  }

  if (unavailable.length > 0 || markRaw === null || askRaw === null || bidRaw === null) {
    return { ...common, loading: false, inputs: null, unavailable };
  }

  // The real two-sided quote — never the mark stood in for a missing side (`spreadAvailable`
  // above). `price` is the mark because that is what the publisher signs as the report's
  // `price`, and it is the value `_getTradePriceImpact` measures the deviation against.
  const inputs: LadderInputs = {
    netVolThreshold: chain.netVolThreshold,
    decayRate: chain.decayRate,
    priceImpactK: chain.priceImpactK,
    buyVolume: chain.buyVolume,
    sellVolume: chain.sellVolume,
    lastUpdateTimestamp: chain.lastUpdateTimestamp,
    blockTimestamp: chain.blockTimestamp,
    price: markRaw,
    askPrice: askRaw,
    bidPrice: bidRaw,
  };

  return { ...common, loading: false, inputs, unavailable: [] };
}

export interface QuoteResult extends QuoteInputsResult {
  /** Null exactly when `inputs` is null. */
  quote: Quote | null;
}

/**
 * The vault's live two-sided quote for `notionalRaw` (1e6 USDW, collateral x leverage) on
 * `pairIndex`: Buy and Sell prices for that size, the spread and the slippage from the mark.
 * An empty order (`notionalRaw` 0) is quoted at one USDW — the pure half-spread.
 */
export function useQuote(pairIndex: number | null, notionalRaw: bigint): QuoteResult {
  const result = useQuoteInputs(pairIndex);
  const quote = useMemo(
    () => (result.inputs ? quoteForNotional(result.inputs, notionalRaw) : null),
    [result.inputs, notionalRaw],
  );
  return { ...result, quote };
}
