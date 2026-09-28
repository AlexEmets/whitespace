import { impactAtSize, PRECISION_18, type LadderInputs } from './priceImpact';

/**
 * The two-sided quote the vault gives for one order size — what the terminal shows in place of
 * an order book.
 *
 * Whitespace has no book (spec 2026-09-28-testnet-perfect-design.md §3). Like Variational's RFQ
 * panel, the trader sees "Buy @ x / Sell @ y for the size you typed", because that is the whole
 * truth: the vault is the only counterparty and its price is a deterministic function of the
 * oracle quote, the recent one-sided volume and the size (`priceImpact.ts`, transcribed from the
 * contract). Nothing here approximates — both prices are the contract's own fill formula.
 */
export interface Quote {
  /** 1e6 USDW notional the quote is for. */
  notionalRaw: bigint;
  /** 1e18. What a LONG of this size opens at. */
  buyPrice: bigint;
  /** 1e18. What a SHORT of this size opens at. */
  sellPrice: bigint;
  /** 1e18 mark the fills are measured against. */
  mark: bigint;
  /** Percent at 1e18 scale (1e18 == 1.00%): (buy - sell) / mark. */
  spreadP: bigint;
  /** Percent at 1e18 scale, how far a long fills from the mark. Negative = better than mark. */
  buySlippageP: bigint;
  /** Percent at 1e18 scale, how far a short fills from the mark. Negative = better than mark. */
  sellSlippageP: bigint;
  /** False when the pair has no size-dependent impact configured (priceImpactK == 0). */
  isDynamic: boolean;
}

/**
 * The size an empty order field is quoted at: one USDW of notional. The dynamic impact term is
 * zero below the pair's net-volume threshold, so this is the pure half-spread quote — the
 * "top of book" a trader sees before typing anything.
 */
export const MIN_QUOTE_NOTIONAL_RAW = 1_000_000n;

function percentOf(delta: bigint, base: bigint): bigint {
  return (delta * PRECISION_18 * 100n) / base;
}

export function quoteForNotional(inputs: LadderInputs, notionalRaw: bigint): Quote {
  if (inputs.price <= 0n) throw new Error('quote: mark must be > 0');
  const size = notionalRaw > 0n ? notionalRaw : MIN_QUOTE_NOTIONAL_RAW;
  const long = impactAtSize(inputs, 'long', size);
  const short = impactAtSize(inputs, 'short', size);
  const mark = inputs.price;
  return {
    notionalRaw: size,
    buyPrice: long.priceAfterImpact,
    sellPrice: short.priceAfterImpact,
    mark,
    spreadP: percentOf(long.priceAfterImpact - short.priceAfterImpact, mark),
    buySlippageP: percentOf(long.priceAfterImpact - mark, mark),
    sellSlippageP: percentOf(mark - short.priceAfterImpact, mark),
    isDynamic: long.isDynamic,
  };
}

/**
 * The worst fill the contract will accept for `slippageBps` around `wantedPrice`, per
 * `TradingCallbacksLib` (`wantedPrice * slippageP / 100 / 100`): a long reverts-by-cancel above
 * it, a short below it. Shown next to the quote so the trader sees both "what you'll probably
 * get" and "what you'll accept".
 */
export function worstAcceptablePrice(wantedPrice: bigint, slippageBps: bigint, buy: boolean): bigint {
  const band = (wantedPrice * slippageBps) / 100n / 100n;
  return buy ? wantedPrice + band : wantedPrice - band;
}

/**
 * The smallest max-slippage (bps, rounded up) that still accepts the quoted fill of `side`,
 * so the default tolerance can be set to cover the quote plus a margin instead of a constant
 * that a large order silently exceeds.
 */
export function slippageBpsToCover(quote: Quote, buy: boolean): bigint {
  const fill = buy ? quote.buyPrice : quote.sellPrice;
  const delta = buy ? fill - quote.mark : quote.mark - fill;
  if (delta <= 0n) return 0n;
  return (delta * 10_000n + quote.mark - 1n) / quote.mark;
}
