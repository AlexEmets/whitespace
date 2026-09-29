import { describe, expect, it } from 'vitest';
import {
  slippageForSubmission,
  tpSlErrors,
  triggerPriceError,
  updateSlError,
  updateTpError,
} from '@/lib/orderRules';

const E18 = 10n ** 18n;
const P = 100_000n * E18;

describe('tpSlErrors (TradingLib.getOpenTradeRevert)', () => {
  it('accepts none, and a long with TP above and SL below the entry', () => {
    expect(tpSlErrors({ buy: true, entryPrice: P, tp: 0n, sl: 0n })).toEqual({ tp: null, sl: null });
    expect(tpSlErrors({ buy: true, entryPrice: P, tp: P + 1n, sl: P - 1n })).toEqual({ tp: null, sl: null });
  });

  it('rejects a long TP at or below entry and SL at or above it — the boundary is inclusive', () => {
    expect(tpSlErrors({ buy: true, entryPrice: P, tp: P, sl: 0n }).tp).toMatch(/above/);
    expect(tpSlErrors({ buy: true, entryPrice: P, tp: 0n, sl: P }).sl).toMatch(/below/);
  });

  it('mirrors the rules for a short', () => {
    expect(tpSlErrors({ buy: false, entryPrice: P, tp: P - 1n, sl: P + 1n })).toEqual({ tp: null, sl: null });
    expect(tpSlErrors({ buy: false, entryPrice: P, tp: P, sl: 0n }).tp).toMatch(/below/);
    expect(tpSlErrors({ buy: false, entryPrice: P, tp: 0n, sl: P }).sl).toMatch(/above/);
  });

  it('rejects negative values', () => {
    expect(tpSlErrors({ buy: true, entryPrice: P, tp: -1n, sl: -1n })).toEqual({
      tp: 'Take profit cannot be negative.',
      sl: 'Stop loss cannot be negative.',
    });
  });
});

describe('updateTpError (OstiumTrading.updateTp)', () => {
  // 10x: maxDist = P * 900 / 1000 = 0.9 P
  const base = { buy: true, openPrice: P, leverage: 1_000n, initialLeverage: 1_000n };
  it('refuses zero — a TP can be moved, never removed', () => {
    expect(updateTpError({ ...base, newTp: 0n })).toMatch(/cannot be removed/);
  });
  it('accepts exactly the +900% boundary and refuses one wei past it', () => {
    expect(updateTpError({ ...base, newTp: P + (P * 9n) / 10n })).toBeNull();
    expect(updateTpError({ ...base, newTp: P + (P * 9n) / 10n + 1n })).toMatch(/900%/);
  });
  it('uses the larger of initial and current leverage', () => {
    // initial 20x → maxDist 0.45 P even though leverage is now 10x
    expect(updateTpError({ ...base, initialLeverage: 2_000n, newTp: P + P / 2n })).toMatch(/900%/);
  });
  it('floors the short boundary at zero instead of underflowing', () => {
    // 1x: maxDist = 9 P > P, so any positive TP is fine for a short
    expect(updateTpError({ buy: false, openPrice: P, leverage: 100n, initialLeverage: 100n, newTp: 1n })).toBeNull();
  });
});

describe('updateSlError (OstiumTrading.updateSl)', () => {
  const base = { buy: true, openPrice: P, leverage: 1_000n, maxSlP: 75n };
  it('zero removes the stop', () => {
    expect(updateSlError({ ...base, newSl: 0n })).toBeNull();
  });
  it('accepts the loss-limit boundary and refuses one wei further', () => {
    // maxDist = P * 75 / 1000 = 0.075 P
    const edge = P - (P * 75n) / 1_000n;
    expect(updateSlError({ ...base, newSl: edge })).toBeNull();
    expect(updateSlError({ ...base, newSl: edge - 1n })).toMatch(/75%/);
  });
  it('mirrors for a short', () => {
    const edge = P + (P * 75n) / 1_000n;
    expect(updateSlError({ ...base, buy: false, newSl: edge })).toBeNull();
    expect(updateSlError({ ...base, buy: false, newSl: edge + 1n })).toMatch(/75%/);
  });
});

describe('triggerPriceError', () => {
  it('ignores market orders', () => {
    expect(triggerPriceError('MARKET', true, 0n, P)).toBeNull();
  });
  it('has nothing to say about a trigger that has not been typed', () => {
    // An empty trigger is not an error to show; the form keeps the order unplaceable instead.
    expect(triggerPriceError('LIMIT', true, 0n, P)).toBeNull();
    expect(triggerPriceError('STOP', false, 0n, P)).toBeNull();
  });
  it('a limit waits on the better side of the market', () => {
    expect(triggerPriceError('LIMIT', true, P - 1n, P)).toBeNull();
    expect(triggerPriceError('LIMIT', true, P, P)).toMatch(/below/);
    expect(triggerPriceError('LIMIT', false, P + 1n, P)).toBeNull();
    expect(triggerPriceError('LIMIT', false, P, P)).toMatch(/above/);
  });
  it('a stop waits on the breakout side', () => {
    expect(triggerPriceError('STOP', true, P + 1n, P)).toBeNull();
    expect(triggerPriceError('STOP', true, P, P)).toMatch(/above/);
    expect(triggerPriceError('STOP', false, P - 1n, P)).toBeNull();
    expect(triggerPriceError('STOP', false, P, P)).toMatch(/below/);
  });
});

describe('slippageForSubmission (OstiumTrading.openTrade)', () => {
  it('is exactly zero for resting orders', () => {
    expect(slippageForSubmission('LIMIT', 50n)).toBe(0n);
    expect(slippageForSubmission('STOP', 50n)).toBe(0n);
  });
  it('is clamped into the open interval (0, 10000) for market orders', () => {
    expect(slippageForSubmission('MARKET', 50n)).toBe(50n);
    expect(slippageForSubmission('MARKET', 0n)).toBe(1n);
    expect(slippageForSubmission('MARKET', 10_000n)).toBe(9_999n);
  });
});
