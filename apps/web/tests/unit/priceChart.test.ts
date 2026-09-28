import { describe, expect, it } from 'vitest';
import {
  MIN_VISIBLE_CANDLES,
  clampView,
  domainWithMark,
  formatAxisTime,
  isDefaultView,
  niceStep,
  panView,
  priceTicks,
  applyWheelZoom,
  timeTickIndices,
  wheelZoomFactor,
  zoomView,
} from '@/components/PriceChart';

/** 18-decimal raw price for a whole number of dollars. */
const usd = (n: bigint) => n * 10n ** 18n;

describe('clampView', () => {
  it('collapses to an empty window when there are no candles', () => {
    expect(clampView({ visible: 50, endOffset: 10 }, 0)).toEqual({ visible: 0, endOffset: 0 });
  });

  it('never shows fewer than MIN_VISIBLE_CANDLES', () => {
    expect(clampView({ visible: 3, endOffset: 0 }, 500).visible).toBe(MIN_VISIBLE_CANDLES);
  });

  it('never shows more candles than are loaded', () => {
    expect(clampView({ visible: 900, endOffset: 0 }, 120).visible).toBe(120);
  });

  it('holds the minimum slot count so a short series keeps a normal bar width', () => {
    // Reverses the previous rule ("7 candles render as 7 candles"). Bar width is
    // plotW / visible, so a window pinned to however many candles exist made width a
    // function of history length: with two buckets the plot drew two hairlines four
    // hundred pixels apart. The window counts SLOTS with a floor instead, and the series
    // occupies the right-hand ones — the empty space sits to its left.
    expect(clampView({ visible: 7, endOffset: 0 }, 7)).toEqual({
      visible: MIN_VISIBLE_CANDLES,
      endOffset: 0,
    });
    expect(clampView({ visible: 1, endOffset: 0 }, 7).visible).toBe(MIN_VISIBLE_CANDLES);
  });

  it('right-anchors a short series, leaving the empty slots on the left', () => {
    // The regression this whole change exists for. Two buckets must land in the last two
    // of MIN_VISIBLE_CANDLES slots — beside each other at the live edge — not spread
    // across the full plot width. Mirrors the leading-slot arithmetic in the component.
    const total = 2;
    const view = clampView({ visible: total, endOffset: 0 }, total);
    const leadingSlots = Math.max(0, -(total - view.visible - view.endOffset));

    expect(view.visible).toBe(MIN_VISIBLE_CANDLES);
    expect(leadingSlots).toBe(MIN_VISIBLE_CANDLES - total);
    // Newest candle occupies the final slot.
    expect(leadingSlots + (total - 1)).toBe(MIN_VISIBLE_CANDLES - 1);
  });

  it('leaves nothing to scroll when the window already outruns the series', () => {
    // `total - visible` is negative here; the offset range must collapse to [0, 0] rather
    // than letting a pan drag the only two bars off the plot.
    expect(clampView({ visible: MIN_VISIBLE_CANDLES, endOffset: 5 }, 2)).toEqual({
      visible: MIN_VISIBLE_CANDLES,
      endOffset: 0,
    });
  });

  it('clamps the pan offset so the window cannot leave the series', () => {
    expect(clampView({ visible: 20, endOffset: 999 }, 100).endOffset).toBe(80);
    expect(clampView({ visible: 20, endOffset: -50 }, 100).endOffset).toBe(0);
  });

  it('rounds fractional drag offsets to whole candles', () => {
    expect(clampView({ visible: 20, endOffset: 4.6 }, 100).endOffset).toBe(5);
  });
});

describe('zoomView', () => {
  it('zooming out widens the window', () => {
    const out = zoomView({ visible: 40, endOffset: 0 }, 400, 1.15, 1);
    expect(out.visible).toBeGreaterThan(40);
  });

  it('zooming in narrows the window', () => {
    const inn = zoomView({ visible: 40, endOffset: 0 }, 400, 1 / 1.15, 1);
    expect(inn.visible).toBeLessThan(40);
  });

  it('holds the bar under the cursor in place', () => {
    const total = 400;
    const start = { visible: 100, endOffset: 50 };
    const ratio = 0.25;
    const anchorBefore = total - start.visible - start.endOffset + ratio * start.visible;
    const next = zoomView(start, total, 1 / 1.15, ratio);
    const anchorAfter = total - next.visible - next.endOffset + ratio * next.visible;
    // Rounding to whole candles means this is exact only to within a bar.
    expect(Math.abs(anchorAfter - anchorBefore)).toBeLessThanOrEqual(1);
  });

  it('zooming at the live edge stays at the live edge', () => {
    expect(zoomView({ visible: 100, endOffset: 0 }, 400, 1 / 1.15, 1).endOffset).toBe(0);
  });

  it('cannot be zoomed out past the whole series', () => {
    let v = { visible: 100, endOffset: 0 };
    for (let i = 0; i < 50; i += 1) v = zoomView(v, 300, 1.15, 0.5);
    expect(v).toEqual({ visible: 300, endOffset: 0 });
  });

  it('cannot be zoomed in past the minimum', () => {
    let v = { visible: 300, endOffset: 0 };
    for (let i = 0; i < 100; i += 1) v = zoomView(v, 300, 1 / 1.15, 0.5);
    expect(v.visible).toBe(MIN_VISIBLE_CANDLES);
  });

  it('clamps a cursor ratio from outside the plot instead of extrapolating', () => {
    const a = zoomView({ visible: 100, endOffset: 20 }, 400, 1.15, -3);
    const b = zoomView({ visible: 100, endOffset: 20 }, 400, 1.15, 0);
    expect(a).toEqual(b);
  });

  it('is a no-op on an empty series', () => {
    expect(zoomView({ visible: 0, endOffset: 0 }, 0, 1.15, 0.5)).toEqual({ visible: 0, endOffset: 0 });
  });
});

describe('panView', () => {
  it('walks back in time and returns to the live edge', () => {
    const back = panView({ visible: 50, endOffset: 0 }, 400, 30);
    expect(back.endOffset).toBe(30);
    expect(panView(back, 400, -30).endOffset).toBe(0);
  });

  it('stops at the oldest candle', () => {
    expect(panView({ visible: 50, endOffset: 0 }, 400, 10_000).endOffset).toBe(350);
  });

  it('stops at the newest candle', () => {
    expect(panView({ visible: 50, endOffset: 10 }, 400, -10_000).endOffset).toBe(0);
  });

  it('keeps the window width while panning', () => {
    expect(panView({ visible: 50, endOffset: 0 }, 400, 120).visible).toBe(50);
  });
});

describe('isDefaultView', () => {
  it('is true only for the whole series pinned to the live edge', () => {
    expect(isDefaultView({ visible: 400, endOffset: 0 }, 400)).toBe(true);
    expect(isDefaultView({ visible: 100, endOffset: 0 }, 400)).toBe(false); // zoomed
    expect(isDefaultView({ visible: 350, endOffset: 5 }, 400)).toBe(false); // panned
  });

  it('normalises away an offset that cannot exist, so reset does not stay enabled forever', () => {
    // Showing all 400 bars leaves nothing to pan into, so endOffset 5 is not a state the
    // chart can be in — clampView collapses it and the affordance correctly reads "at
    // default" rather than offering a reset that would change nothing.
    expect(isDefaultView({ visible: 400, endOffset: 5 }, 400)).toBe(true);
  });
});

describe('niceStep', () => {
  it('picks a round step that divides the range into about the requested number', () => {
    expect(niceStep(1000n, 5)).toBe(200n);
    expect(niceStep(1n, 5)).toBe(1n);
    expect(niceStep(37n, 1)).toBe(20n);
    expect(niceStep(100n, 5)).toBe(20n);
    expect(niceStep(90n, 5)).toBe(20n);
  });

  it('only ever returns a 1/2/2.5/5 x 10^n step', () => {
    const mantissas = new Set<string>();
    for (const range of [7n, 93n, 352n, 1499n, 60_000n, usd(3n), usd(412n)]) {
      const step = niceStep(range, 5);
      mantissas.add(step.toString().replace(/0+$/, ''));
    }
    for (const m of mantissas) expect(['1', '2', '25', '5']).toContain(m);
  });

  it('does not overshoot into a 3-label axis where 7 fit', () => {
    // The regression this rule exists for: a 352-wide domain over 5 target levels. The
    // "smallest covering step" rule returns 100 here and draws three gridlines.
    expect(niceStep(352n, 5)).toBe(50n);
    expect(352n / niceStep(352n, 5)).toBe(7n);
  });

  it('never returns a step of zero for a degenerate range', () => {
    expect(niceStep(0n, 5)).toBe(1n);
    expect(niceStep(-5n, 5)).toBe(1n);
    expect(niceStep(3n, 5)).toBe(1n);
  });

  it('handles an 18-decimal price range without overflowing to a float', () => {
    // 100 dollars of range at 18 decimals is 1e20 — well past Number.MAX_SAFE_INTEGER.
    const step = niceStep(usd(100n), 5);
    expect(step).toBe(20n * 10n ** 18n);
    expect(typeof step).toBe('bigint');
  });
});

describe('priceTicks', () => {
  it('produces round levels inside the domain', () => {
    const ticks = priceTicks(usd(100n), usd(200n), 5);
    expect(ticks).toEqual([usd(100n), usd(120n), usd(140n), usd(160n), usd(180n), usd(200n)]);
  });

  it('never emits a tick outside the domain', () => {
    const min = usd(78_103n);
    const max = usd(78_197n);
    for (const t of priceTicks(min, max, 5)) {
      expect(t >= min).toBe(true);
      expect(t <= max).toBe(true);
    }
  });

  it('lands near the requested number of levels', () => {
    const ticks = priceTicks(usd(78_103n), usd(78_197n), 5);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });

  it('gives a flat series exactly one level', () => {
    expect(priceTicks(usd(5n), usd(5n), 5)).toEqual([usd(5n)]);
  });

  it('returns nothing for an inverted domain rather than looping', () => {
    expect(priceTicks(usd(9n), usd(1n), 5)).toEqual([]);
  });

  it('stays exact — ticks are bigints, never rounded through a double', () => {
    const ticks = priceTicks(1n, 10n, 5);
    expect(ticks).toEqual([2n, 4n, 6n, 8n, 10n]);
  });
});

describe('timeTickIndices', () => {
  it('labels every candle when there are few enough', () => {
    expect(timeTickIndices(4, 6)).toEqual([0, 1, 2, 3]);
  });

  it('strides from the right so the newest candle is always labelled', () => {
    const ticks = timeTickIndices(100, 6);
    expect(ticks[ticks.length - 1]).toBe(99);
    expect(ticks.length).toBeLessThanOrEqual(6);
  });

  it('returns strictly increasing indices inside range', () => {
    const ticks = timeTickIndices(37, 5);
    for (let i = 1; i < ticks.length; i += 1) expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ticks)).toBeLessThan(37);
  });

  it('is empty for an empty series', () => {
    expect(timeTickIndices(0, 6)).toEqual([]);
    expect(timeTickIndices(10, 0)).toEqual([]);
  });
});

describe('formatAxisTime', () => {
  const t = 1788991140; // 2026-09-09T21:59:00Z

  it('shows hour and minute for intraday intervals', () => {
    expect(formatAxisTime(t, '1m', 'UTC')).toBe('21:59');
    expect(formatAxisTime(t, '15m', 'UTC')).toBe('21:59');
    expect(formatAxisTime(t, '1h', 'UTC')).toBe('21:59');
  });

  it('adds the date where an hour alone would be ambiguous', () => {
    expect(formatAxisTime(t, '4h', 'UTC')).toBe('09/09 21:59');
  });

  it('drops the time entirely on a daily chart', () => {
    expect(formatAxisTime(t, '1d', 'UTC')).toBe('09/09');
  });
});

describe('domainWithMark', () => {
  const lo = usd(100n);
  const hi = usd(200n);

  it('widens the domain to keep a nearby mark on screen', () => {
    expect(domainWithMark(lo, hi, usd(220n))).toEqual({ min: lo, max: usd(220n) });
    expect(domainWithMark(lo, hi, usd(80n))).toEqual({ min: usd(80n), max: hi });
  });

  it('leaves the domain alone when the mark is already inside it', () => {
    expect(domainWithMark(lo, hi, usd(150n))).toEqual({ min: lo, max: hi });
  });

  it('refuses to flatten the candles for a far-away mark', () => {
    // A frozen or badly-diverged mark must not squash 100 dollars of real range.
    expect(domainWithMark(lo, hi, usd(9_000n))).toEqual({ min: lo, max: hi });
    expect(domainWithMark(lo, hi, usd(1n))).toEqual({ min: lo, max: hi });
  });

  it('is a no-op when there is no mark yet', () => {
    expect(domainWithMark(lo, hi, null)).toEqual({ min: lo, max: hi });
  });
});

/**
 * Wheel zoom. A trackpad fires dozens of small wheel events per gesture; zooming a fixed step
 * per event (the old 15%) turned one gentle two-finger stroke into a lurch. The factor now
 * follows how far the wheel actually moved.
 */
describe('wheelZoomFactor', () => {
  const PIXELS = 0;
  const LINES = 1;

  it('zooms out for a positive delta and in for a negative one', () => {
    expect(wheelZoomFactor(100, PIXELS, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-100, PIXELS, false)).toBeLessThan(1);
    expect(wheelZoomFactor(0, PIXELS, false)).toBe(1);
  });

  it('is symmetric, so in-then-out returns to where it started', () => {
    expect(wheelZoomFactor(100, PIXELS, false) * wheelZoomFactor(-100, PIXELS, false)).toBeCloseTo(1, 10);
  });

  it('moves a mouse notch (≈100 px) by well under the old 15%', () => {
    const notch = wheelZoomFactor(100, PIXELS, false);
    expect(notch).toBeGreaterThan(1.04);
    expect(notch).toBeLessThan(1.1);
  });

  it('moves one small trackpad event by under 1%', () => {
    expect(wheelZoomFactor(4, PIXELS, false)).toBeLessThan(1.01);
  });

  it('treats a line-mode delta (Firefox mouse wheel) like the pixels it stands for', () => {
    expect(wheelZoomFactor(3, LINES, false)).toBeCloseTo(wheelZoomFactor(48, PIXELS, false), 10);
  });

  it('keeps a trackpad pinch gentle per event', () => {
    // Pinch arrives as wheel events with ctrlKey and deltas of a few units each.
    const pinch = wheelZoomFactor(3, PIXELS, true);
    expect(pinch).toBeGreaterThan(wheelZoomFactor(3, PIXELS, false));
    expect(pinch).toBeLessThan(1.03);
  });

  it('caps a single runaway event', () => {
    expect(wheelZoomFactor(10_000, PIXELS, false)).toBeLessThanOrEqual(1.2);
    expect(wheelZoomFactor(-10_000, PIXELS, false)).toBeGreaterThanOrEqual(1 / 1.2);
  });
});

/**
 * The window holds a whole number of candles, so a trackpad's sub-1% steps would each round
 * away to nothing. They are banked until they add up to a whole candle.
 */
describe('applyWheelZoom', () => {
  const TOTAL = 500;
  const trackpadStep = wheelZoomFactor(4, 0, false);

  it('banks a step too small to move a whole candle, leaving the view as it was', () => {
    const view = { visible: 100, endOffset: 0 };
    const step = applyWheelZoom(view, TOTAL, trackpadStep, 1);
    expect(step.view).toEqual(view);
    expect(step.pending).toBeCloseTo(trackpadStep, 10);
  });

  it('turns a run of small trackpad steps into real zoom', () => {
    let view = { visible: 100, endOffset: 0 };
    let pending = 1;
    for (let i = 0; i < 40; i++) {
      const step = applyWheelZoom(view, TOTAL, pending * trackpadStep, 1);
      view = step.view;
      pending = step.pending;
    }
    // 40 steps of ~0.28% ≈ 11.8% wider, give or take the candle still in the bank.
    expect(view.visible).toBeGreaterThanOrEqual(110);
    expect(view.visible).toBeLessThanOrEqual(112);
  });

  it('spends the bank once it moves the window', () => {
    const step = applyWheelZoom({ visible: 100, endOffset: 0 }, TOTAL, 1.05, 1);
    expect(step.view.visible).toBe(105);
    expect(step.pending).toBeCloseTo(1, 10);
  });

  it('does not bank zoom-in past the tightest window, so reversing responds at once', () => {
    const floor = { visible: MIN_VISIBLE_CANDLES, endOffset: 0 };
    expect(applyWheelZoom(floor, TOTAL, 1 / 1.01, 1).pending).toBe(1);
  });

  it('does not bank zoom-out past the whole series', () => {
    const everything = { visible: TOTAL, endOffset: 0 };
    expect(applyWheelZoom(everything, TOTAL, 1.01, 1).pending).toBe(1);
  });
});
