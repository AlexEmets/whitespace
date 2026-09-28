import { describe, expect, it } from 'vitest';
import type { LadderInputs } from '@/lib/priceImpact';
import {
  MIN_QUOTE_NOTIONAL_RAW,
  quoteForNotional,
  slippageBpsToCover,
  worstAcceptablePrice,
} from '@/lib/quote';

/**
 * Expected values are worked by hand from TradingCallbacksLib.sol (`_priceImpactFunction`,
 * `getDynamicTradePriceImpact`) in exact integer arithmetic — never produced by the module.
 *
 * Fixture: mark 100,000, bid/ask ±10 (a 0.01% half-spread), K = 2e18, threshold $50k, no
 * accumulated volume and no decay — the BTC/USD parameters of the testnet deploy.
 */
const E18 = 10n ** 18n;
const USDW = 1_000_000n;

const inputs: LadderInputs = {
  netVolThreshold: 50_000n * E18,
  decayRate: 0n,
  priceImpactK: 2n * E18,
  buyVolume: 0n,
  sellVolume: 0n,
  lastUpdateTimestamp: 0n,
  blockTimestamp: 0n,
  price: 100_000n * E18,
  askPrice: 100_010n * E18,
  bidPrice: 99_990n * E18,
};

describe('quoteForNotional', () => {
  it('quotes an empty order at one USDW: the pure half-spread, symmetric around the mark', () => {
    const q = quoteForNotional(inputs, 0n);
    expect(q.notionalRaw).toBe(MIN_QUOTE_NOTIONAL_RAW);
    // spreadComponent = 20e18 * 1e18 * 100 / 2e23 = 1e16 (0.01%)
    expect(q.buyPrice).toBe(100_010n * E18);
    expect(q.sellPrice).toBe(99_990n * E18);
    expect(q.spreadP).toBe(2n * 10n ** 16n); // 0.02%
    expect(q.buySlippageP).toBe(10n ** 16n);
    expect(q.sellSlippageP).toBe(10n ** 16n);
    expect(q.isDynamic).toBe(true);
  });

  it('below the net-volume threshold a larger order is quoted the same as a tiny one', () => {
    const q = quoteForNotional(inputs, 40_000n * USDW);
    expect(q.buyPrice).toBe(100_010n * E18);
    expect(q.sellPrice).toBe(99_990n * E18);
  });

  it('past the threshold the quote widens with size — exactly the contract curve', () => {
    // size 5e23, excess 4.5e23: dyn = 2e18 * (4.5e23)^2 * 100 / (2 * 5e23) / 1e27 = 4.05e16
    // impact = 1e16 + 4.05e16 = 5.05e16 → ×(1 ± 5.05e14/1e18)
    const q = quoteForNotional(inputs, 500_000n * USDW);
    expect(q.buyPrice).toBe(100_050_500_000_000_000_000_000n);
    expect(q.sellPrice).toBe(99_949_500_000_000_000_000_000n);
    expect(q.spreadP).toBe(101_000_000_000_000_000n); // 0.101%
    expect(q.buySlippageP).toBe(50_500_000_000_000_000n);
  });

  it('without configured impact every size is quoted at the raw oracle ask and bid', () => {
    const q = quoteForNotional({ ...inputs, priceImpactK: 0n }, 5_000_000n * USDW);
    expect(q.isDynamic).toBe(false);
    expect(q.buyPrice).toBe(100_010n * E18);
    expect(q.sellPrice).toBe(99_990n * E18);
  });

  it('a mark outside the two-sided quote yields a negative slippage, not a clamped zero', () => {
    const q = quoteForNotional({ ...inputs, priceImpactK: 0n, price: 100_020n * E18 }, USDW);
    expect(q.buySlippageP < 0n).toBe(true);
  });

  it('refuses a non-positive mark instead of quoting against it', () => {
    expect(() => quoteForNotional({ ...inputs, price: 0n }, USDW)).toThrow(/mark/);
  });
});

describe('worstAcceptablePrice', () => {
  it('bands the wanted price by slippage bps on the losing side', () => {
    expect(worstAcceptablePrice(100_000n * E18, 50n, true)).toBe(100_500n * E18);
    expect(worstAcceptablePrice(100_000n * E18, 50n, false)).toBe(99_500n * E18);
    expect(worstAcceptablePrice(100_000n * E18, 0n, true)).toBe(100_000n * E18);
  });
});

describe('slippageBpsToCover', () => {
  it('rounds UP to the bps that still accepts the quoted fill', () => {
    const q = quoteForNotional(inputs, 500_000n * USDW); // long fills 5.05 bps over mark
    expect(slippageBpsToCover(q, true)).toBe(6n);
    expect(slippageBpsToCover(q, false)).toBe(6n);
  });

  it('is exact when the fill sits on a whole bps', () => {
    const q = quoteForNotional(inputs, USDW); // 1 bps either side
    expect(slippageBpsToCover(q, true)).toBe(1n);
  });

  it('is zero when the fill is at or better than the mark', () => {
    const q = quoteForNotional({ ...inputs, priceImpactK: 0n, price: 100_020n * E18 }, USDW);
    expect(slippageBpsToCover(q, true)).toBe(0n);
  });
});
