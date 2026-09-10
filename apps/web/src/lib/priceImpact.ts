/**
 * The vault's price-impact curve, transcribed 1:1 from the Solidity that actually fills a
 * trade: `contracts/src/vendor/ostium/lib/TradingCallbacksLib.sol`, functions
 * `_priceImpactFunction`, `getDynamicTradePriceImpact`, `_getEffectiveDecayRate` and
 * `_decayVolumeWithPade`. Every line below has a `// solidity:` marker naming the
 * expression it mirrors.
 *
 * Why transcribe rather than approximate: this is the number that decides what a trader
 * is actually filled at. Whitespace has no order book — it is a vault-backed,
 * oracle-priced perp — so "depth" here is not other people's resting orders, it is *this
 * formula*: how far the vault moves your fill away from the oracle price as your size
 * grows. A ladder that is close-but-not-exact would be worse than no ladder at all, so
 * every operation keeps Solidity's exact evaluation order and its exact truncating
 * integer division.
 *
 * SCALES (all bigint, never a JS number — see src/lib/money.ts):
 *   - price / ask / bid          1e18   (PRICE_DECIMALS)
 *   - buyVolume / sellVolume     1e18   USD notional (IOstiumPairInfos.DynamicSpreadState)
 *   - netVolThreshold            1e18   USD notional
 *   - decayRate                  1e18   per second
 *   - priceImpactK               1e27   (PRECISION_27)
 *   - tradeNotional              1e18   USD notional = collateral(1e6) * leverage(1e2) * 1e10
 *   - priceImpactP               1e18   PERCENT, i.e. 1e18 == 1.00%. Not a fraction.
 *
 * bigint `/` truncates toward zero and every operand here is non-negative, which is
 * exactly Solidity's `/` for unsigned integers — so the transcription is bit-exact, not
 * merely close.
 */

/** solidity: `uint64 constant PRECISION_18 = 1e18` (TradingCallbacksLib.sol:19). */
export const PRECISION_18 = 10n ** 18n;
/** solidity: `uint256 constant PRECISION_27 = 1e27` (TradingCallbacksLib.sol:18). */
export const PRECISION_27 = 10n ** 27n;
/** solidity: `uint64 constant PRECISION_10 = 1e10` (TradingCallbacksLib.sol:20). */
export const PRECISION_10 = 10n ** 10n;
/** solidity: `uint64 constant MAX_DECAY_FACTOR = 3e18` (TradingCallbacksLib.sol:23). */
export const MAX_DECAY_FACTOR = 3n * PRECISION_18;
/** 100% expressed in the `priceImpactP` scale — the clamp in `getDynamicTradePriceImpact`. */
export const FULL_IMPACT_P = 100n * PRECISION_18;

const UINT128_MASK = (1n << 128n) - 1n;

/** Solidity's `uint128(x)` narrowing cast: wraps, it does not saturate. Reproduced so a
 * pathological on-chain value produces the same wrong-looking number here as on chain
 * rather than a different one. */
function asUint128(value: bigint): bigint {
  return value & UINT128_MASK;
}

/**
 * solidity: `_getEffectiveDecayRate` (TradingCallbacksLib.sol:499-516).
 *
 * The configured decay rate, slowed down when the pair is already imbalanced: the further
 * |buy - sell| is past `netVolThreshold`, the larger the divisor, up to MAX_DECAY_FACTOR
 * (3x slower). Computed from the *undecayed* volumes — the contract calls this before
 * applying the Padé decay, and the order matters.
 */
export function getEffectiveDecayRate(
  buyVolume: bigint,
  sellVolume: bigint,
  decayRate: bigint,
  netVolThreshold: bigint,
): bigint {
  if (netVolThreshold === 0n) {
    return asUint128((decayRate * PRECISION_18) / MAX_DECAY_FACTOR);
  }
  const absNetVol = buyVolume > sellVolume ? buyVolume - sellVolume : sellVolume - buyVolume;

  let factor = PRECISION_18;
  if (absNetVol > netVolThreshold) {
    const ratio = (absNetVol * PRECISION_18) / netVolThreshold;
    factor = ratio > MAX_DECAY_FACTOR ? MAX_DECAY_FACTOR : ratio;
  }

  return asUint128((decayRate * PRECISION_18) / factor);
}

/**
 * solidity: `_decayVolumeWithPade` (TradingCallbacksLib.sol:377-392).
 *
 * A first-order Padé approximant of `volume * e^(-rate*dt)`: with `h = rate*dt/2`, the
 * multiplier is `(1-h)/(1+h)` in 1e18 fixed point, floored at 0. This is fully
 * reproducible in integer arithmetic — there is no series, no exponential, nothing that
 * needs floating point — so this client-side copy is exact rather than an approximation
 * of the on-chain decay.
 *
 * @param decayInterval seconds elapsed since `lastUpdateTimestamp` (Solidity's uint32 dt)
 */
export function decayVolumeWithPade(volume: bigint, decayInterval: bigint, decayRate: bigint): bigint {
  if (decayInterval === 0n) {
    return volume;
  }

  const decayFactorHalf = (decayRate * decayInterval) / 2n;
  const numerator = PRECISION_18 > decayFactorHalf ? PRECISION_18 - decayFactorHalf : 0n;
  const denominator = PRECISION_18 + decayFactorHalf;
  const decayMultiplier = (numerator * PRECISION_18) / denominator;

  // The Solidity returns `uint128(...)`, narrowing a uint256 — kept, so a >2^128 volume
  // wraps identically here.
  return asUint128((volume * decayMultiplier) / PRECISION_18);
}

export interface PriceImpactFunctionInputs {
  /** 1e18 USD notional. Below this, only the oracle spread contributes. */
  netVolThreshold: bigint;
  /** 1e27. Zero means the pair has no dynamic impact configured at all. */
  priceImpactK: bigint;
  /** 1e18 USD notional of the hypothetical trade. */
  tradeSize: bigint;
  /** 1e18 USD notional already accumulated on this side, after decay. */
  initialVol: bigint;
  /** 1e18 oracle price / ask / bid. */
  midPrice: bigint;
  askPrice: bigint;
  bidPrice: bigint;
}

/**
 * solidity: `_priceImpactFunction` (TradingCallbacksLib.sol:393-415). Returns
 * `priceImpactP`, a PERCENT at 1e18 scale.
 *
 * Two additive parts:
 *   spreadComponent  = (ask - bid) * 1e18 * 100 / (mid * 2)      -- half the oracle spread
 *   dynamicComponent = 0 unless tradeSize + initialVol crosses netVolThreshold, then
 *       initialVol <  threshold : K * excess^2 * 100 / (2*tradeSize) / 1e27   (quadratic
 *                                 ramp — only the part of the trade past the threshold
 *                                 pays, averaged over the whole trade)
 *       initialVol >= threshold : K * (initialVol - threshold + tradeSize/2) * 100 / 1e27
 *                                 (linear — already past the threshold, so the average
 *                                 excess over the trade is its midpoint)
 */
export function priceImpactFunction(inputs: PriceImpactFunctionInputs): bigint {
  const { netVolThreshold, priceImpactK, tradeSize, initialVol, midPrice, askPrice, bidPrice } = inputs;

  // Both of these revert on-chain rather than returning a wrong number; refuse here too
  // instead of emitting a plausible-looking value.
  if (midPrice <= 0n) {
    throw new Error('priceImpact: midPrice must be > 0 (the contract divides by mid * 2)');
  }
  if (askPrice < bidPrice) {
    throw new Error('priceImpact: askPrice < bidPrice underflows the contract subtraction');
  }

  const spreadComponent = ((askPrice - bidPrice) * PRECISION_18 * 100n) / (midPrice * 2n);
  let dynamicComponent = 0n;

  const finalVol = tradeSize + initialVol;
  if (finalVol > netVolThreshold) {
    const excessVol = finalVol - netVolThreshold;
    if (initialVol < netVolThreshold) {
      if (tradeSize === 0n) {
        throw new Error('priceImpact: tradeSize must be > 0 (the contract divides by 2 * tradeSize)');
      }
      dynamicComponent = (priceImpactK * excessVol * excessVol * 100n) / (2n * tradeSize) / PRECISION_27;
    } else {
      dynamicComponent = (priceImpactK * (initialVol - netVolThreshold + tradeSize / 2n) * 100n) / PRECISION_27;
    }
  }

  return spreadComponent + dynamicComponent;
}

/**
 * solidity: `tradeNotional = collateralValue * trade.leverage * PRECISION_10`
 * (TradingCallbacksLib.sol:447).
 *
 * Only the *product* enters the formula, so 25,000 USDW of notional costs the same impact
 * whether it is 25,000 at 1x or 2,500 at 10x.
 *
 * @param collateralRaw 1e6 USDW, as `collateralToRaw` produces
 * @param leverageRaw   1e2, as `leverageToRaw` produces
 * @returns 1e18 USD notional
 */
export function tradeNotionalOf(collateralRaw: bigint, leverageRaw: bigint): bigint {
  return collateralRaw * leverageRaw * PRECISION_10;
}

export interface ImpactResult {
  /** PERCENT at 1e18 scale. Clamped to exactly 100e18 when the short side is wiped out. */
  priceImpactP: bigint;
  /** 1e18 execution price after impact. Zero only in the clamped case. */
  priceAfterImpact: bigint;
}

/**
 * solidity: `_getTradePriceImpact` (TradingCallbacksLib.sol:39-55) — the STATIC path.
 *
 *     if (price == 0) return (0, 0);
 *     bool aboveSpot  = (isOpen == isLong);
 *     int192 usedPrice = aboveSpot ? ask : bid;
 *     priceImpactP = SignedMath.abs(price - usedPrice) * 1e18 * 100 / price;
 *     return (priceImpactP, usedPrice);
 *
 * `getDynamicTradePriceImpact` calls exactly this, and returns it unchanged with
 * `isDynamic: false`, whenever `priceImpactK == 0` (line 428-435). So on a pair with no
 * dynamic spread configured, the fill price is LITERALLY the oracle ask (opening a long,
 * or closing a short) or the oracle bid (the other two) — no size term anywhere in it.
 *
 * Two things this does NOT do, and both matter for how the ladder renders it:
 *   - `priceImpactP` is an ABSOLUTE deviation (`SignedMath.abs`), so it carries no
 *     direction. The direction is `usedPrice` vs `price`, which is NOT always "worse":
 *     `price` is the EMA mark while ask/bid are the current index quote, so the mark can
 *     sit outside the two-sided quote and a fill can land on the favourable side of it.
 *   - there is no >=100% clamp on this path; it cannot run away, because the result is a
 *     quoted price rather than a multiplier applied to one.
 */
export function staticTradePriceImpact(
  price: bigint,
  askPrice: bigint,
  bidPrice: bigint,
  aboveSpot: boolean,
): ImpactResult {
  if (price === 0n) {
    return { priceImpactP: 0n, priceAfterImpact: 0n };
  }
  const usedPrice = aboveSpot ? askPrice : bidPrice;
  const deviation = price > usedPrice ? price - usedPrice : usedPrice - price;
  return { priceImpactP: (deviation * PRECISION_18 * 100n) / price, priceAfterImpact: usedPrice };
}

/**
 * solidity: the tail of `getDynamicTradePriceImpact` (TradingCallbacksLib.sol:454-467).
 *
 * `aboveSpot` is the contract's `isOpen == trade.buy`: opening a long, or closing a short,
 * fills you ABOVE the oracle price; the other two fill BELOW it. Note the asymmetry is in
 * the source, not a mistake here — only the below-spot branch has the >=100% clamp,
 * because only it can drive the price through zero.
 *
 * `priceImpactP / 100` is Solidity's integer division converting a 1e18-scaled percent
 * into a 1e18-scaled fraction, and it truncates. Kept verbatim.
 */
export function applyPriceImpact(price: bigint, priceImpactP: bigint, aboveSpot: boolean): ImpactResult {
  let priceAfterImpact = price;
  let impactP = priceImpactP;

  if (impactP > 0n) {
    if (aboveSpot) {
      priceAfterImpact = (priceAfterImpact * (PRECISION_18 + impactP / 100n)) / PRECISION_18;
    } else if (impactP < FULL_IMPACT_P) {
      priceAfterImpact = (priceAfterImpact * (PRECISION_18 - impactP / 100n)) / PRECISION_18;
    } else {
      priceAfterImpact = 0n;
      impactP = FULL_IMPACT_P;
    }
  }

  return { priceImpactP: impactP, priceAfterImpact };
}

export interface LadderInputs {
  /** `pairDynamicSpreadParams(pairIndex).netVolThreshold`, 1e18. */
  netVolThreshold: bigint;
  /** `pairDynamicSpreadParams(pairIndex).decayRate`, 1e18/second. */
  decayRate: bigint;
  /** `getPairPriceImpactK(pairIndex)`, 1e27. */
  priceImpactK: bigint;
  /** `pairDynamicSpreadState(pairIndex).buyVolume`, 1e18, BEFORE decay. */
  buyVolume: bigint;
  /** `pairDynamicSpreadState(pairIndex).sellVolume`, 1e18, BEFORE decay. */
  sellVolume: bigint;
  /** `pairDynamicSpreadState(pairIndex).lastUpdateTimestamp`, unix seconds. */
  lastUpdateTimestamp: bigint;
  /** Chain time the decay is evaluated at — the latest block's timestamp. */
  blockTimestamp: bigint;
  /** 1e18 oracle price, ask and bid at fill time. */
  price: bigint;
  askPrice: bigint;
  bidPrice: bigint;
}

export interface LadderRow {
  /** 'long' opens a long (fills at the oracle ask), 'short' opens a short (at the bid). */
  side: 'long' | 'short';
  /** The size level this row answers for, 1e6 USDW notional. */
  notionalRaw: bigint;
  /** The same level in the contract's 1e18 units. */
  tradeNotional: bigint;
  /** PERCENT at 1e18 scale. ABSOLUTE — see `priceAfterImpact` for the direction. */
  priceImpactP: bigint;
  /** 1e18 execution price. */
  priceAfterImpact: bigint;
  /**
   * The contract's own `PriceImpactResult.isDynamic`. False means `priceImpactK == 0` and
   * this row came from the static spread path, so it is identical at every size — not a
   * rendering shortcut but the actual behaviour of this pair.
   */
  isDynamic: boolean;
}

/**
 * The decayed side-volume the contract would use for a trade on `side`, at
 * `blockTimestamp`.
 *
 * solidity: `getDynamicTradePriceImpact` lines 441-445. `initialVolume` is
 * `(trade.buy == isOpen) ? buyVolume : sellVolume`; the ladder is always about *opening*
 * (`isOpen == true`), so a long reads buyVolume and a short reads sellVolume.
 */
export function decayedInitialVolume(inputs: LadderInputs, side: 'long' | 'short'): bigint {
  const { buyVolume, sellVolume, decayRate, netVolThreshold, lastUpdateTimestamp, blockTimestamp } = inputs;

  // solidity: `block.timestamp > lastUpdateTimestamp ? uint32(block.timestamp) - lastUpdateTimestamp : 0`.
  // The uint32 narrowing is a no-op until the 2106 wrap, so it is not reproduced; a
  // post-wrap chain would revert on-chain, not return a different number.
  const dt = blockTimestamp > lastUpdateTimestamp ? blockTimestamp - lastUpdateTimestamp : 0n;

  const effectiveDecayRate = getEffectiveDecayRate(buyVolume, sellVolume, decayRate, netVolThreshold);
  const initialVolume = side === 'long' ? buyVolume : sellVolume;
  return decayVolumeWithPade(initialVolume, dt, effectiveDecayRate);
}

/**
 * Evaluates one ladder row: "if I opened `notionalRaw` USDW of notional on `side` right
 * now, what price would the vault fill me at?".
 *
 * @param notionalRaw 1e6 USDW notional (collateral x leverage — only the product matters)
 */
export function impactAtSize(inputs: LadderInputs, side: 'long' | 'short', notionalRaw: bigint): LadderRow {
  // The contract builds its notional as collateral(1e6) * leverage(1e2) * 1e10. Feeding
  // the level as collateral at 1.00x leverage reproduces that expression exactly rather
  // than open-coding a `* 1e12` shortcut.
  const tradeNotional = tradeNotionalOf(notionalRaw, 100n);
  // solidity: `isOpen == trade.buy`. The ladder is always about opening, so a long is
  // above spot and a short below.
  const aboveSpot = side === 'long';

  // solidity: `getDynamicTradePriceImpact` lines 428-435 — with `priceImpactK == 0` the
  // contract never evaluates the dynamic curve at all. It is not that the dynamic result
  // happens to be zero; the whole branch is skipped and the static spread path answers.
  if (inputs.priceImpactK === 0n) {
    const staticResult = staticTradePriceImpact(inputs.price, inputs.askPrice, inputs.bidPrice, aboveSpot);
    return { side, notionalRaw, tradeNotional, isDynamic: false, ...staticResult };
  }

  const priceImpactP = priceImpactFunction({
    netVolThreshold: inputs.netVolThreshold,
    priceImpactK: inputs.priceImpactK,
    tradeSize: tradeNotional,
    initialVol: decayedInitialVolume(inputs, side),
    midPrice: inputs.price,
    askPrice: inputs.askPrice,
    bidPrice: inputs.bidPrice,
  });

  const result = applyPriceImpact(inputs.price, priceImpactP, aboveSpot);

  return {
    side,
    notionalRaw,
    tradeNotional,
    isDynamic: true,
    priceImpactP: result.priceImpactP,
    priceAfterImpact: result.priceAfterImpact,
  };
}

/**
 * Both sides of the ladder for a list of size levels, in the order the panel renders them:
 * longs largest-first (worst fill at the top, walking down toward the oracle price) and
 * shorts smallest-first (walking away from it downward) — the geometry of a book, with
 * the vault's own curve in place of resting orders.
 */
export function buildImpactLadder(
  inputs: LadderInputs,
  levelsRaw: readonly bigint[],
): { long: LadderRow[]; short: LadderRow[] } {
  const ascending = [...levelsRaw].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    long: [...ascending].reverse().map((level) => impactAtSize(inputs, 'long', level)),
    short: ascending.map((level) => impactAtSize(inputs, 'short', level)),
  };
}
