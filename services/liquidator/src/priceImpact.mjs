/**
 * The vault's fill-price function, transcribed from
 * contracts/src/vendor/ostium/lib/TradingCallbacksLib.sol so the bot can decide TP and
 * LIMIT triggers on the same number the callback compares:
 *
 *   _getTradePriceImpact          :39-54   static path (priceImpactK == 0)
 *   getDynamicTradePriceImpact    :523-574 dispatch + dynamic path
 *   _decayVolumeWithPade          :482-497
 *   _priceImpactFunction          :499-521
 *   _getEffectiveDecayRate        :604-620
 *   calculatePostFeeCollateral    :624-649
 *
 * Same transcription as apps/web/src/lib/priceImpact.ts (the terminal's quote), kept as
 * plain .mjs here because services cannot import the web app. bigint throughout; every
 * operand is non-negative, so bigint `/` truncation equals Solidity's unsigned `/`.
 *
 * The one input that is NOT exact is time: the contract decays side volume to the
 * callback's `block.timestamp`, which is a few blocks after the bot decides. The decay
 * only ever reduces volume (and so impact) as time passes; the contract re-decides at
 * execution anyway, so a boundary miss costs one NOT_HIT, never a wrong execution.
 */

export const PRECISION_6 = 10n ** 6n;
export const PRECISION_10 = 10n ** 10n;
export const PRECISION_18 = 10n ** 18n;
export const PRECISION_27 = 10n ** 27n;
export const MAX_DECAY_FACTOR = 3n * PRECISION_18;
export const FULL_IMPACT_P = 100n * PRECISION_18;

const UINT128_MASK = (1n << 128n) - 1n;
const asUint128 = (v) => v & UINT128_MASK;

/** TradingCallbacksLib.sol:604-620 */
export function getEffectiveDecayRate(buyVolume, sellVolume, decayRate, netVolThreshold) {
  if (netVolThreshold === 0n) return asUint128((decayRate * PRECISION_18) / MAX_DECAY_FACTOR);
  const absNetVol = buyVolume > sellVolume ? buyVolume - sellVolume : sellVolume - buyVolume;
  let factor = PRECISION_18;
  if (absNetVol > netVolThreshold) {
    const ratio = (absNetVol * PRECISION_18) / netVolThreshold;
    factor = ratio > MAX_DECAY_FACTOR ? MAX_DECAY_FACTOR : ratio;
  }
  return asUint128((decayRate * PRECISION_18) / factor);
}

/** TradingCallbacksLib.sol:482-497 */
export function decayVolumeWithPade(volume, decayInterval, decayRate) {
  if (decayInterval === 0n) return volume;
  const half = (decayRate * decayInterval) / 2n;
  const numerator = PRECISION_18 > half ? PRECISION_18 - half : 0n;
  const denominator = PRECISION_18 + half;
  const multiplier = (numerator * PRECISION_18) / denominator;
  return asUint128((volume * multiplier) / PRECISION_18);
}

/** TradingCallbacksLib.sol:499-521. Returns priceImpactP, a percent at 1e18 (1e18 = 1%). */
export function priceImpactFunction({ netVolThreshold, priceImpactK, tradeSize, initialVol, midPrice, askPrice, bidPrice }) {
  if (midPrice <= 0n) throw new Error('priceImpact: midPrice must be > 0');
  if (askPrice < bidPrice) throw new Error('priceImpact: ask < bid underflows on-chain');
  const spreadComponent = ((askPrice - bidPrice) * PRECISION_18 * 100n) / (midPrice * 2n);
  let dynamicComponent = 0n;
  const finalVol = tradeSize + initialVol;
  if (finalVol > netVolThreshold) {
    const excessVol = finalVol - netVolThreshold;
    dynamicComponent =
      initialVol < netVolThreshold
        ? (priceImpactK * excessVol * excessVol * 100n) / (2n * tradeSize) / PRECISION_27
        : (priceImpactK * (initialVol - netVolThreshold + tradeSize / 2n) * 100n) / PRECISION_27;
  }
  return spreadComponent + dynamicComponent;
}

/**
 * TradingCallbacksLib.getDynamicTradePriceImpact (:523-574), including the static
 * `_getTradePriceImpact` branch it takes when `priceImpactK == 0`.
 *
 * @param {object} p
 * @param {bigint} p.price report `price` (the publisher's mark), 1e18
 * @param {bigint} p.ask report `ask`, 1e18
 * @param {bigint} p.bid report `bid`, 1e18
 * @param {boolean} p.isOpen
 * @param {boolean} p.buy
 * @param {bigint} p.collateral collateralValue argument, 1e6
 * @param {bigint} p.leverage 1e2
 * @param {{ priceImpactK: bigint, netVolThreshold: bigint, decayRate: bigint,
 *           buyVolume: bigint, sellVolume: bigint, lastUpdateTimestamp: bigint }} p.impact
 * @param {bigint} p.blockTimestamp seconds
 * @returns {{ priceImpactP: bigint, priceAfterImpact: bigint, isDynamic: boolean }}
 */
export function getDynamicTradePriceImpact({ price, ask, bid, isOpen, buy, collateral, leverage, impact, blockTimestamp }) {
  const aboveSpot = isOpen === buy;
  if (impact.priceImpactK === 0n) {
    // _getTradePriceImpact (:39-54)
    if (price === 0n) return { priceImpactP: 0n, priceAfterImpact: 0n, isDynamic: false };
    const used = aboveSpot ? ask : bid;
    const dev = price > used ? price - used : used - price;
    return { priceImpactP: (dev * PRECISION_18 * 100n) / price, priceAfterImpact: used, isDynamic: false };
  }

  const dt = blockTimestamp > impact.lastUpdateTimestamp ? blockTimestamp - impact.lastUpdateTimestamp : 0n;
  const effectiveDecayRate = getEffectiveDecayRate(impact.buyVolume, impact.sellVolume, impact.decayRate, impact.netVolThreshold);
  const initialVolume = decayVolumeWithPade(buy === isOpen ? impact.buyVolume : impact.sellVolume, dt, effectiveDecayRate);
  const tradeNotional = collateral * leverage * PRECISION_10;

  let priceImpactP = priceImpactFunction({
    netVolThreshold: impact.netVolThreshold,
    priceImpactK: impact.priceImpactK,
    tradeSize: tradeNotional,
    initialVol: initialVolume,
    midPrice: price,
    askPrice: ask,
    bidPrice: bid,
  });

  let priceAfterImpact = price;
  if (priceImpactP > 0n) {
    if (aboveSpot) {
      priceAfterImpact = (priceAfterImpact * (PRECISION_18 + priceImpactP / 100n)) / PRECISION_18;
    } else if (priceImpactP < FULL_IMPACT_P) {
      priceAfterImpact = (priceAfterImpact * (PRECISION_18 - priceImpactP / 100n)) / PRECISION_18;
    } else {
      priceAfterImpact = 0n;
      priceImpactP = FULL_IMPACT_P;
    }
  }
  return { priceImpactP, priceAfterImpact, isDynamic: true };
}

/**
 * TradingCallbacksLib.calculatePostFeeCollateral (:624-649) — the collateral a limit
 * entry's impact is sized on (OstiumTradingCallbacks.sol:442-444).
 *
 * @param {{ collateral: bigint, leverage: bigint, takerFeeP: bigint, oracleFee: bigint,
 *           builder: string, builderFee: bigint }} p
 */
export function calculatePostFeeCollateral({ collateral, leverage, takerFeeP, oracleFee, builder, builderFee }) {
  const preFeeNotional = (collateral * leverage) / 100n;
  let builderFeeAmount = 0n;
  if (builder && builder !== '0x0000000000000000000000000000000000000000' && builderFee > 0n) {
    builderFeeAmount = (builderFee * preFeeNotional) / PRECISION_6 / 100n;
  }
  const openingFee = (preFeeNotional * takerFeeP) / PRECISION_6 / 100n;
  const total = openingFee + oracleFee + builderFeeAmount;
  // On-chain this underflows and reverts the callback; the order cannot fill.
  if (total > collateral) return null;
  return collateral - total;
}
