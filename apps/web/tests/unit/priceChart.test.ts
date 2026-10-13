import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISIBLE_CANDLES,
  HISTORY_PAGE_CANDLES,
  MAX_VISIBLE_CANDLES,
  MIN_VISIBLE_CANDLES,
  OVERSCROLL_KEEP,
  RIGHT_MARGIN_CANDLES,
  clampView,
  countAppendedOnRight,
  defaultView,
  freshRange,
  labelClearOfChips,
  maxVisible,
  panPriceDomain,
  priceAxisZoomFactor,
  scalePriceDomain,
  timeAxisZoomFactor,
  wantsOlderCandles,
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

  /** As on TradingView: the series can be dragged past either end into empty space, but
   * never off the plot — OVERSCROLL_KEEP candles stay in view. It used to stop at the
   * ends, and with the window opening on the whole series that meant no drag at all. */
  it('lets the window run past either end until OVERSCROLL_KEEP candles are left', () => {
    expect(clampView({ visible: 20, endOffset: 999 }, 100).endOffset).toBe(100 - OVERSCROLL_KEEP);
    expect(clampView({ visible: 20, endOffset: -50 }, 100).endOffset).toBe(-(20 - OVERSCROLL_KEEP));
  });

  it('caps the window at MAX_VISIBLE_CANDLES however much history is loaded', () => {
    expect(maxVisible(5000)).toBe(MAX_VISIBLE_CANDLES);
    expect(clampView({ visible: 9999, endOffset: 0 }, 5000).visible).toBe(MAX_VISIBLE_CANDLES);
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

  it('cannot be zoomed out past the whole series, and then shows all of it', () => {
    let v = { visible: 100, endOffset: 0 };
    for (let i = 0; i < 50; i += 1) v = zoomView(v, 300, 1.15, 0.5);
    expect(v).toEqual({ visible: 300, endOffset: 0 });
  });

  it('zooming out from a window dragged into empty space still ends on the whole series', () => {
    let v = { visible: 40, endOffset: -30 };
    for (let i = 0; i < 50; i += 1) v = zoomView(v, 120, 1.15, 0.9);
    expect(v.visible).toBe(120);
    expect(v.endOffset).toBe(0);
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

  it('runs past the oldest candle, stopping with OVERSCROLL_KEEP of them still in view', () => {
    expect(panView({ visible: 50, endOffset: 0 }, 400, 10_000).endOffset).toBe(400 - OVERSCROLL_KEEP);
  });

  it('runs past the newest candle into empty space, stopping the same way', () => {
    expect(panView({ visible: 50, endOffset: 10 }, 400, -10_000).endOffset).toBe(-(50 - OVERSCROLL_KEEP));
  });

  it('keeps the window width while panning', () => {
    expect(panView({ visible: 50, endOffset: 0 }, 400, 120).visible).toBe(50);
  });
});

describe('defaultView', () => {
  /** A chart opened on the whole loaded history had nowhere to be dragged. */
  it('opens on the latest stretch with a little room right of the live bar', () => {
    expect(defaultView(1000)).toEqual({ visible: DEFAULT_VISIBLE_CANDLES, endOffset: -RIGHT_MARGIN_CANDLES });
  });

  it('leaves older history to the left of the window to drag back into', () => {
    const v = defaultView(1000);
    const firstSlot = 1000 - v.visible - v.endOffset;
    expect(firstSlot).toBeGreaterThan(0);
  });

  it('keeps the normal bar width for a short series', () => {
    expect(defaultView(7).visible).toBe(MIN_VISIBLE_CANDLES);
  });

  it('is empty for an empty series', () => {
    expect(defaultView(0)).toEqual({ visible: 0, endOffset: 0 });
  });
});

describe('isDefaultView', () => {
  it('is true only where the chart opened', () => {
    expect(isDefaultView(defaultView(400), 400)).toBe(true);
    expect(isDefaultView({ visible: 60, endOffset: -RIGHT_MARGIN_CANDLES }, 400)).toBe(false); // zoomed
    expect(isDefaultView({ visible: DEFAULT_VISIBLE_CANDLES, endOffset: 40 }, 400)).toBe(false); // panned
  });

  it('normalises a window wider than a short series, so reset does not stay enabled forever', () => {
    expect(isDefaultView({ visible: 999, endOffset: -RIGHT_MARGIN_CANDLES }, 10)).toBe(true);
  });
});

describe('history paging', () => {
  it('opens on one page of the interval, up to now', () => {
    expect(freshRange(3600, 1_000_000_000)).toEqual({ from: 1_000_000_000 - 3600 * HISTORY_PAGE_CANDLES, to: 1_000_000_000 });
  });

  it('wants the page before once the window is within a window of the oldest bar', () => {
    expect(wantsOlderCandles(defaultView(1000), 1000)).toBe(false);
    expect(wantsOlderCandles({ visible: 100, endOffset: 790 }, 1000)).toBe(false); // first slot 110
    expect(wantsOlderCandles({ visible: 100, endOffset: 820 }, 1000)).toBe(true);
    expect(wantsOlderCandles({ visible: 100, endOffset: 995 }, 1000)).toBe(true);
  });

  it('wants nothing from an empty series', () => {
    expect(wantsOlderCandles({ visible: 0, endOffset: 0 }, 0)).toBe(false);
  });
});

describe('countAppendedOnRight', () => {
  const series = (ts: number[]) => ts.map((t) => ({ t }));

  it('counts live buckets added after the newest one', () => {
    expect(countAppendedOnRight(300, series([100, 200, 300, 400, 500]))).toBe(2);
  });

  /** The bug it exists for: a page of history grows the series on the LEFT, and treating
   * that as new bars would yank a scrolled-back window by a whole page. */
  it('counts nothing for a page of older history', () => {
    expect(countAppendedOnRight(300, series([-200, -100, 0, 100, 200, 300]))).toBe(0);
  });

  it('counts nothing when the live bucket is only updated in place, or there was no series', () => {
    expect(countAppendedOnRight(300, series([100, 200, 300]))).toBe(0);
    expect(countAppendedOnRight(null, series([100, 200]))).toBe(0);
  });
});

describe('price scale by hand', () => {
  const d = { min: usd(100n), max: usd(200n) };

  it('stretches and squeezes about the centre', () => {
    expect(scalePriceDomain(d, 2)).toEqual({ min: usd(50n), max: usd(250n) });
    expect(scalePriceDomain(d, 0.5)).toEqual({ min: usd(125n), max: usd(175n) });
  });

  it('never squeezes to nothing, and never below a price of zero', () => {
    const tiny = scalePriceDomain(d, 1e-12);
    expect(tiny.max).toBeGreaterThan(tiny.min);
    expect(scalePriceDomain({ min: 1n, max: usd(1n) }, 50).min).toBeGreaterThanOrEqual(1n);
  });

  it('pans with the pointer: dragging down by half the plot shows prices half a range higher', () => {
    expect(panPriceDomain(d, 200, 400)).toEqual({ min: usd(150n), max: usd(250n) });
    expect(panPriceDomain(d, -200, 400)).toEqual({ min: usd(50n), max: usd(150n) });
  });

  it('cannot be panned below a price of zero', () => {
    const p = panPriceDomain(d, -10_000, 400);
    expect(p.min).toBe(1n);
    expect(p.max - p.min).toBe(d.max - d.min);
  });

  it('drags like TradingView: down on the price axis widens the range, up narrows it, and back undoes it', () => {
    expect(priceAxisZoomFactor(50)).toBeGreaterThan(1);
    expect(priceAxisZoomFactor(-50)).toBeLessThan(1);
    expect(priceAxisZoomFactor(50) * priceAxisZoomFactor(-50)).toBeCloseTo(1, 10);
  });

  it('zooms time in when the time axis is dragged right, out when dragged left', () => {
    expect(timeAxisZoomFactor(40)).toBeLessThan(1);
    expect(timeAxisZoomFactor(-40)).toBeGreaterThan(1);
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

describe('labelClearOfChips', () => {
  /** "83,404.34" used to print straight over the "83,400.00" level beneath it. */
  it('hides an axis label that a price chip sits on', () => {
    expect(labelClearOfChips(100, [104])).toBe(false);
    expect(labelClearOfChips(100, [null, 95])).toBe(false);
  });

  it('keeps labels a chip height or more away, and all of them with no chip', () => {
    expect(labelClearOfChips(100, [114])).toBe(true);
    expect(labelClearOfChips(100, [null, null])).toBe(true);
  });
});
