import { describe, expect, it } from 'vitest';
import {
  applyPriceImpact,
  staticTradePriceImpact,
  buildImpactLadder,
  decayVolumeWithPade,
  decayedInitialVolume,
  FULL_IMPACT_P,
  getEffectiveDecayRate,
  impactAtSize,
  type LadderInputs,
  priceImpactFunction,
  tradeNotionalOf,
} from '@/lib/priceImpact';
import { collateralToRaw, leverageToRaw } from '@/lib/money';

/**
 * Every expected value in this file was computed independently of src/lib/priceImpact.ts —
 * evaluated by hand from the Solidity text of
 * contracts/src/vendor/ostium/lib/TradingCallbacksLib.sol (`_priceImpactFunction`,
 * `getDynamicTradePriceImpact`, `_getEffectiveDecayRate`, `_decayVolumeWithPade`) in exact
 * integer arithmetic, then written out as literals. Asserting against a value the module
 * itself produced would test nothing.
 *
 * Scale reminder: `priceImpactP` is a PERCENT at 1e18 scale, so 405000000000000000n is
 * 0.405%, and FULL_IMPACT_P (100e18) is 100%.
 */

const E18 = 10n ** 18n;
const PRICE = 100_000n * E18; // 100,000.00

/** Ostium-shaped parameters: 100,000 USD threshold, K = 1e19 (i.e. 1e-8 at PRECISION_27). */
const NET_VOL_THRESHOLD = 100_000n * E18;
const K = 10n ** 19n;
/** 1,000,000 USD of notional — the deepest rung the panel quotes. */
const TRADE_1M = 1_000_000n * E18;

describe('priceImpactFunction — spread component', () => {
  it('is zero when the oracle quotes no spread', () => {
    expect(
      priceImpactFunction({
        netVolThreshold: NET_VOL_THRESHOLD,
        priceImpactK: 0n,
        tradeSize: TRADE_1M,
        initialVol: 0n,
        midPrice: PRICE,
        askPrice: PRICE,
        bidPrice: PRICE,
      }),
    ).toBe(0n);
  });

  it('is (ask - bid) * 1e18 * 100 / (mid * 2) — half the spread, as a percent', () => {
    // ask 100.10, bid 100.00, mid 100.05 -> 1e37 / 2.001e20 = 49975012493753123 (floored)
    const ask = 100_100_000_000_000_000_000n;
    const bid = 100n * E18;
    const mid = 100_050_000_000_000_000_000n;
    expect(
      priceImpactFunction({
        netVolThreshold: NET_VOL_THRESHOLD,
        priceImpactK: 0n,
        tradeSize: TRADE_1M,
        initialVol: 0n,
        midPrice: mid,
        askPrice: ask,
        bidPrice: bid,
      }),
    ).toBe(49_975_012_493_753_123n); // 0.049975...%
  });

  it('adds cleanly on top of the dynamic component', () => {
    const ask = 100_100_000_000_000_000_000n;
    const bid = 100n * E18;
    const mid = 100_050_000_000_000_000_000n;
    // 49975012493753123 (spread) + 405000000000000000 (quadratic branch below)
    expect(
      priceImpactFunction({
        netVolThreshold: NET_VOL_THRESHOLD,
        priceImpactK: K,
        tradeSize: TRADE_1M,
        initialVol: 0n,
        midPrice: mid,
        askPrice: ask,
        bidPrice: bid,
      }),
    ).toBe(454_975_012_493_753_123n);
  });

  it('refuses a zero mid instead of dividing by zero the way the contract reverts', () => {
    expect(() =>
      priceImpactFunction({
        netVolThreshold: 0n,
        priceImpactK: K,
        tradeSize: TRADE_1M,
        initialVol: 0n,
        midPrice: 0n,
        askPrice: 0n,
        bidPrice: 0n,
      }),
    ).toThrow(/midPrice/);
  });
});

describe('priceImpactFunction — dynamic component', () => {
  it('is zero while the trade stays under netVolThreshold', () => {
    // 1,000 + 0 = 1,000 USD, far under the 100,000 threshold.
    expect(
      priceImpactFunction({
        netVolThreshold: NET_VOL_THRESHOLD,
        priceImpactK: K,
        tradeSize: 1_000n * E18,
        initialVol: 0n,
        midPrice: PRICE,
        askPrice: PRICE,
        bidPrice: PRICE,
      }),
    ).toBe(0n);
  });

  it('initialVol < netVolThreshold: quadratic branch, K*excess^2*100/(2*size)/1e27', () => {
    // excess = 1,000,000 - 100,000 = 900,000e18 = 9e23
    // 1e19 * (9e23)^2 * 100 / (2 * 1e24) / 1e27 = 4.05e17 -> 0.405%
    expect(
      priceImpactFunction({
        netVolThreshold: NET_VOL_THRESHOLD,
        priceImpactK: K,
        tradeSize: TRADE_1M,
        initialVol: 0n,
        midPrice: PRICE,
        askPrice: PRICE,
        bidPrice: PRICE,
      }),
    ).toBe(405_000_000_000_000_000n);
  });

  it('initialVol >= netVolThreshold: linear branch, K*(initialVol-threshold+size/2)*100/1e27', () => {
    // 1e19 * (5e23 - 1e23 + 5e23) * 100 / 1e27 = 9e17 -> 0.900%
    expect(
      priceImpactFunction({
        netVolThreshold: NET_VOL_THRESHOLD,
        priceImpactK: K,
        tradeSize: TRADE_1M,
        initialVol: 500_000n * E18,
        midPrice: PRICE,
        askPrice: PRICE,
        bidPrice: PRICE,
      }),
    ).toBe(900_000_000_000_000_000n);
  });

  it('takes the LINEAR branch at initialVol == netVolThreshold, not the quadratic one', () => {
    // The Solidity condition is `initialVol < netVolThreshold`, so equality falls through
    // to the linear branch: 1e19 * (0 + 5e23) * 100 / 1e27 = 5e17 -> 0.500%. The quadratic
    // branch would have given 1e19*(1e24)^2*100/(2e24)/1e27 = 5e17 too at this exact point
    // (the curve is continuous), so the discriminating case is the one below.
    expect(
      priceImpactFunction({
        netVolThreshold: NET_VOL_THRESHOLD,
        priceImpactK: K,
        tradeSize: TRADE_1M,
        initialVol: NET_VOL_THRESHOLD,
        midPrice: PRICE,
        askPrice: PRICE,
        bidPrice: PRICE,
      }),
    ).toBe(500_000_000_000_000_000n);
  });

  it('the two branches differ once initialVol is past the threshold', () => {
    const common = {
      netVolThreshold: NET_VOL_THRESHOLD,
      priceImpactK: K,
      tradeSize: TRADE_1M,
      midPrice: PRICE,
      askPrice: PRICE,
      bidPrice: PRICE,
    };
    // Linear at initialVol = 500,000 gives 0.900%. Had the quadratic form been used it
    // would be 1e19*(1.4e24)^2*100/(2e24)/1e27 = 9.8e17 = 0.980% — a 9% difference, so the
    // branch really is being taken, not coincidentally agreeing.
    expect(priceImpactFunction({ ...common, initialVol: 500_000n * E18 })).toBe(900_000_000_000_000_000n);
    expect(priceImpactFunction({ ...common, initialVol: 500_000n * E18 })).not.toBe(980_000_000_000_000_000n);
  });

  it('refuses a zero trade size on the quadratic branch (the contract divides by 2*size)', () => {
    expect(() =>
      priceImpactFunction({
        netVolThreshold: 0n,
        priceImpactK: K,
        tradeSize: 0n,
        initialVol: 0n,
        midPrice: PRICE,
        askPrice: PRICE,
        bidPrice: PRICE,
      }),
      // netVolThreshold 0 with initialVol 0 takes the LINEAR branch (0 < 0 is false), so
      // force the quadratic one with a threshold above initialVol.
    ).not.toThrow();
    expect(() =>
      priceImpactFunction({
        netVolThreshold: 1n,
        priceImpactK: K,
        tradeSize: 0n,
        initialVol: 0n,
        midPrice: PRICE,
        askPrice: PRICE,
        bidPrice: PRICE,
      }),
    ).not.toThrow(); // 0 + 0 is not > 1, so no dynamic component at all
    expect(() =>
      priceImpactFunction({
        netVolThreshold: 1n,
        priceImpactK: K,
        tradeSize: 0n,
        initialVol: 2n,
        midPrice: PRICE,
        askPrice: PRICE,
        bidPrice: PRICE,
      }),
      // initialVol 2 >= threshold 1 -> linear, still no division by size.
    ).not.toThrow();
  });
});

describe('applyPriceImpact — direction and clamp', () => {
  it('opening a long fills ABOVE the oracle price', () => {
    // 100,000 * (1e18 + 4.05e17/100) / 1e18 = 100,405.00
    expect(applyPriceImpact(PRICE, 405_000_000_000_000_000n, true)).toEqual({
      priceImpactP: 405_000_000_000_000_000n,
      priceAfterImpact: 100_405n * E18,
    });
  });

  it('opening a short fills BELOW the oracle price by the same amount', () => {
    expect(applyPriceImpact(PRICE, 405_000_000_000_000_000n, false)).toEqual({
      priceImpactP: 405_000_000_000_000_000n,
      priceAfterImpact: 99_595n * E18,
    });
  });

  it('leaves the price untouched at zero impact', () => {
    expect(applyPriceImpact(PRICE, 0n, true)).toEqual({ priceImpactP: 0n, priceAfterImpact: PRICE });
    expect(applyPriceImpact(PRICE, 0n, false)).toEqual({ priceImpactP: 0n, priceAfterImpact: PRICE });
  });

  it('clamps a >=100% impact to zero price on the below-spot side only', () => {
    const twoHundredPercent = 200n * E18;
    expect(applyPriceImpact(PRICE, twoHundredPercent, false)).toEqual({
      priceImpactP: FULL_IMPACT_P,
      priceAfterImpact: 0n,
    });
    // Above spot has no clamp in the Solidity: 100,000 * (1e18 + 2e18) / 1e18 = 300,000.
    expect(applyPriceImpact(PRICE, twoHundredPercent, true)).toEqual({
      priceImpactP: twoHundredPercent,
      priceAfterImpact: 300_000n * E18,
    });
  });

  it('exactly 100% is clamped (the Solidity condition is `< 100e18`)', () => {
    expect(applyPriceImpact(PRICE, FULL_IMPACT_P, false)).toEqual({
      priceImpactP: FULL_IMPACT_P,
      priceAfterImpact: 0n,
    });
  });

  it('a 200% impact reached through the real formula clamps end to end', () => {
    // threshold 0, K = 1e21 (MAX_PRICE_IMPACT_K), initialVol 1e24, size 2e24:
    // linear branch -> 1e21 * (1e24 - 0 + 1e24) * 100 / 1e27 = 2e20 = 200%.
    const p = priceImpactFunction({
      netVolThreshold: 0n,
      priceImpactK: 10n ** 21n,
      tradeSize: 2_000_000n * E18,
      initialVol: 1_000_000n * E18,
      midPrice: PRICE,
      askPrice: PRICE,
      bidPrice: PRICE,
    });
    expect(p).toBe(200n * E18);
    expect(applyPriceImpact(PRICE, p, false)).toEqual({ priceImpactP: FULL_IMPACT_P, priceAfterImpact: 0n });
  });
});

describe('staticTradePriceImpact — the priceImpactK == 0 path', () => {
  // Quote straddling the mark: mid 100,000.00, ask 100,050.00, bid 99,950.00.
  const ASK = 100_050n * E18;
  const BID = 99_950n * E18;

  it('fills a long at the ask, and reports the deviation from price as a percent', () => {
    // |100,000 - 100,050| * 1e18 * 100 / 100,000e18 = 5e16 -> 0.050%
    expect(staticTradePriceImpact(PRICE, ASK, BID, true)).toEqual({
      priceImpactP: 50_000_000_000_000_000n,
      priceAfterImpact: ASK,
    });
  });

  it('fills a short at the bid', () => {
    expect(staticTradePriceImpact(PRICE, ASK, BID, false)).toEqual({
      priceImpactP: 50_000_000_000_000_000n,
      priceAfterImpact: BID,
    });
  });

  it('is zero impact when the quote has collapsed onto the price', () => {
    expect(staticTradePriceImpact(PRICE, PRICE, PRICE, true)).toEqual({
      priceImpactP: 0n,
      priceAfterImpact: PRICE,
    });
  });

  it('returns (0, 0) at price == 0, exactly as the Solidity guard does', () => {
    expect(staticTradePriceImpact(0n, ASK, BID, true)).toEqual({ priceImpactP: 0n, priceAfterImpact: 0n });
  });

  it('takes the ABSOLUTE deviation, so a mark outside the quote still reports a magnitude', () => {
    // This is the live shape: `price` is the EMA mark while ask/bid are the current index
    // quote, so the mark can sit BELOW both. Price 99,900 with the same 99,950/100,050
    // quote: the long fills 150 above (0.150150...%) and the short fills 50 above
    // (0.050050...%) — note the short's fill is ABOVE the mark, i.e. favourable to it, and
    // the Solidity still returns a positive magnitude. Direction is the caller's job.
    const belowQuote = 99_900n * E18;
    expect(staticTradePriceImpact(belowQuote, ASK, BID, true)).toEqual({
      priceImpactP: 150_150_150_150_150_150n,
      priceAfterImpact: ASK,
    });
    expect(staticTradePriceImpact(belowQuote, ASK, BID, false)).toEqual({
      priceImpactP: 50_050_050_050_050_050n,
      priceAfterImpact: BID,
    });
  });

  it('has no >=100% clamp — the result is a quoted price, not a multiplier', () => {
    // A wildly wide quote: ask 10x the price. 900,000 * 1e18 * 100 / 100,000e18 = 900e18.
    const wideAsk = 1_000_000n * E18;
    expect(staticTradePriceImpact(PRICE, wideAsk, BID, true)).toEqual({
      priceImpactP: 900n * E18,
      priceAfterImpact: wideAsk,
    });
  });
});

describe('impactAtSize — routes to the static path when priceImpactK == 0', () => {
  const ASK = 100_050n * E18;
  const BID = 99_950n * E18;
  const staticInputs: LadderInputs = {
    netVolThreshold: NET_VOL_THRESHOLD,
    decayRate: 0n,
    priceImpactK: 0n,
    buyVolume: 0n,
    sellVolume: 0n,
    lastUpdateTimestamp: 0n,
    blockTimestamp: 0n,
    price: PRICE,
    askPrice: ASK,
    bidPrice: BID,
  };

  it('quotes the ask/bid at EVERY size, flagged isDynamic: false', () => {
    for (const level of ['1000', '25000', '1000000']) {
      const long = impactAtSize(staticInputs, 'long', collateralToRaw(level));
      const short = impactAtSize(staticInputs, 'short', collateralToRaw(level));
      expect(long.priceAfterImpact).toBe(ASK);
      expect(short.priceAfterImpact).toBe(BID);
      expect(long.priceImpactP).toBe(50_000_000_000_000_000n);
      expect(long.isDynamic).toBe(false);
      expect(short.isDynamic).toBe(false);
    }
  });

  it('never touches the dynamic curve, even where it would have been huge', () => {
    // With K = 0 the contract skips the whole branch. Prove the accumulated volume that
    // drove a 0.9% dynamic impact above is simply ignored here.
    const loaded = { ...staticInputs, buyVolume: 500_000n * E18 };
    const row = impactAtSize(loaded, 'long', collateralToRaw('1000000'));
    expect(row.priceAfterImpact).toBe(ASK);
    expect(row.priceImpactP).toBe(50_000_000_000_000_000n);
  });

  it('still marks dynamic rows isDynamic: true when K is non-zero', () => {
    const row = impactAtSize({ ...staticInputs, priceImpactK: K }, 'long', collateralToRaw('1000000'));
    expect(row.isDynamic).toBe(true);
  });
});

describe('tradeNotionalOf', () => {
  it('is collateral(1e6) * leverage(1e2) * 1e10', () => {
    // 2,500 USDW at 10x = 25,000 USD of notional at 1e18.
    expect(tradeNotionalOf(collateralToRaw('2500'), leverageToRaw('10'))).toBe(25_000n * E18);
  });

  it('depends only on the product, so 25,000 at 1x is the same notional', () => {
    expect(tradeNotionalOf(collateralToRaw('25000'), leverageToRaw('1'))).toBe(
      tradeNotionalOf(collateralToRaw('2500'), leverageToRaw('10')),
    );
  });
});

describe('getEffectiveDecayRate', () => {
  const RATE = 3n * 10n ** 15n;

  it('is rate/3 when netVolThreshold is 0', () => {
    expect(getEffectiveDecayRate(0n, 0n, RATE, 0n)).toBe(10n ** 15n);
  });

  it('is the configured rate while the pair is balanced within the threshold', () => {
    expect(getEffectiveDecayRate(10n ** 24n, 10n ** 24n, RATE, 10n ** 23n)).toBe(RATE);
  });

  it('slows proportionally once |buy - sell| passes the threshold', () => {
    // |3e23 - 1e23| = 2e23, ratio = 2e18 -> rate * 1e18 / 2e18 = rate/2.
    expect(getEffectiveDecayRate(3n * 10n ** 23n, 10n ** 23n, RATE, 10n ** 23n)).toBe(15n * 10n ** 14n);
  });

  it('never slows past MAX_DECAY_FACTOR (3x)', () => {
    // ratio would be 1e19, clamped to 3e18 -> rate/3.
    expect(getEffectiveDecayRate(10n ** 24n, 0n, RATE, 10n ** 23n)).toBe(10n ** 15n);
  });
});

describe('decayVolumeWithPade', () => {
  it('returns the volume untouched at dt = 0', () => {
    expect(decayVolumeWithPade(10n ** 24n, 0n, 10n ** 15n)).toBe(10n ** 24n);
  });

  it('applies (1-h)/(1+h) with h = rate*dt/2', () => {
    // rate 1e15/s, dt 600 -> h = 3e17; multiplier = 7e17*1e18/1.3e18 = 538461538461538461
    // 1e24 * that / 1e18 = 538461538461538461000000
    expect(decayVolumeWithPade(10n ** 24n, 600n, 10n ** 15n)).toBe(538_461_538_461_538_461_000_000n);
  });

  it('floors at zero once h exceeds 1e18 rather than going negative', () => {
    // rate 1e15/s, dt 3600 -> h = 1.8e18 > 1e18 -> numerator 0.
    expect(decayVolumeWithPade(10n ** 24n, 3600n, 10n ** 15n)).toBe(0n);
  });
});

describe('impactAtSize / buildImpactLadder', () => {
  const base: LadderInputs = {
    netVolThreshold: NET_VOL_THRESHOLD,
    decayRate: 0n,
    priceImpactK: K,
    buyVolume: 0n,
    sellVolume: 0n,
    lastUpdateTimestamp: 0n,
    blockTimestamp: 0n,
    price: PRICE,
    askPrice: PRICE,
    bidPrice: PRICE,
  };

  it('turns a USDW size level into the contract notional and back into a fill price', () => {
    const row = impactAtSize(base, 'long', collateralToRaw('1000000'));
    expect(row.tradeNotional).toBe(TRADE_1M);
    expect(row.priceImpactP).toBe(405_000_000_000_000_000n);
    expect(row.priceAfterImpact).toBe(100_405n * E18);
  });

  it('mirrors the sign for the short side', () => {
    const row = impactAtSize(base, 'short', collateralToRaw('1000000'));
    expect(row.priceImpactP).toBe(405_000_000_000_000_000n);
    expect(row.priceAfterImpact).toBe(99_595n * E18);
  });

  it('reads buyVolume for a long and sellVolume for a short, each decayed', () => {
    const skewed: LadderInputs = {
      ...base,
      buyVolume: 10n ** 24n,
      sellVolume: 0n,
      decayRate: 3n * 10n ** 15n,
      lastUpdateTimestamp: 1_000_000n,
      blockTimestamp: 1_000_600n, // dt = 600s
    };
    // |1e24 - 0| = 1e24 > 1e23 -> ratio 1e19 clamps to 3e18 -> effective rate 1e15.
    // Padé over 600s: 1e24 -> 538461538461538461000000.
    expect(decayedInitialVolume(skewed, 'long')).toBe(538_461_538_461_538_461_000_000n);
    expect(decayedInitialVolume(skewed, 'short')).toBe(0n);

    // Long, 1M notional, initialVol 5.3846e23 >= threshold 1e23 -> linear branch:
    // 1e19 * (538461538461538461000000 - 1e23 + 5e23) * 100 / 1e27 = 938461538461538461
    const long = impactAtSize(skewed, 'long', collateralToRaw('1000000'));
    expect(long.priceImpactP).toBe(938_461_538_461_538_461n);
    expect(long.priceAfterImpact).toBe(100_938_461_538_461_538_400_000n);

    // Short, same size, initialVol 0 -> quadratic branch -> the untouched 0.405%.
    const short = impactAtSize(skewed, 'short', collateralToRaw('1000000'));
    expect(short.priceImpactP).toBe(405_000_000_000_000_000n);
    expect(short.priceAfterImpact).toBe(99_595n * E18);

    // A 1,000 USDW short is under the threshold entirely: no impact at all.
    const smallShort = impactAtSize(skewed, 'short', collateralToRaw('1000'));
    expect(smallShort.priceImpactP).toBe(0n);
    expect(smallShort.priceAfterImpact).toBe(PRICE);
  });

  it('orders longs worst-first and shorts best-first, like a book around the mid', () => {
    const levels = [collateralToRaw('1000'), collateralToRaw('1000000'), collateralToRaw('25000')];
    const { long, short } = buildImpactLadder(base, levels);

    expect(long.map((r) => r.notionalRaw)).toEqual([
      collateralToRaw('1000000'),
      collateralToRaw('25000'),
      collateralToRaw('1000'),
    ]);
    expect(short.map((r) => r.notionalRaw)).toEqual([
      collateralToRaw('1000'),
      collateralToRaw('25000'),
      collateralToRaw('1000000'),
    ]);

    // Longs walk DOWN toward the oracle price as size shrinks; shorts walk away from it.
    expect(long[0]!.priceAfterImpact).toBeGreaterThan(long[2]!.priceAfterImpact);
    expect(long[2]!.priceAfterImpact).toBe(PRICE); // 1,000 is under the threshold
    expect(short[0]!.priceAfterImpact).toBe(PRICE);
    expect(short[2]!.priceAfterImpact).toBeLessThan(PRICE);
  });

  it('produces a flat ladder at the oracle price when priceImpactK is 0', () => {
    // Not what the panel renders — the hook refuses to draw this — but the math must still
    // be honest about it rather than inventing a curve.
    const { long, short } = buildImpactLadder({ ...base, priceImpactK: 0n }, [
      collateralToRaw('1000'),
      collateralToRaw('1000000'),
    ]);
    for (const row of [...long, ...short]) {
      expect(row.priceImpactP).toBe(0n);
      expect(row.priceAfterImpact).toBe(PRICE);
    }
  });
});
