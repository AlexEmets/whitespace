'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { INTERVAL_SECONDS } from '@whitespace/shared/candles';
import { useCandles } from '@/hooks/useCandles';
import { usePrice } from '@/hooks/usePrice';
import { priceToRaw, formatMoney } from '@/lib/money';
import { PRICE_DECIMALS_NUM } from '@/lib/config';
import type { Candle, CandleInterval } from '@/lib/types';
import { DegradedBanner } from './DegradedBanner';
import styles from './PriceChart.module.css';

/** Every interval services/api actually supports (D3) — deliberately not offering the
 * mockup's "1W", which is not one of the enum values GET /candles accepts. */
const INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

/** Height used until the panel has been measured (and in tests, where nothing lays out).
 * In the terminal the chart fills whatever its panel leaves. */
const CHART_HEIGHT = 340;
/** Below this the measured height is not a real layout yet (a collapsed or unmounted
 * panel); keep the default rather than drawing a chart a few pixels tall. */
const MIN_MEASURED_HEIGHT = 160;
/** Right gutter holds the price axis, bottom gutter the time axis. The plot is what is
 * left; everything below is expressed against it so a resize moves one number. */
// 74 on the right fits a ten-character BTC price ("100,000.00") in its chip at the axis font;
// at 66 the last digit of "83,395.28" ran off the edge.
const PAD = { top: 10, right: 74, bottom: 24, left: 8 } as const;
const PRICE_TICK_TARGET = 5;
const TIME_TICK_TARGET = 6;
/** Below this the bars are too thin to read as candles; above `total` there is nothing
 * left to show. Both ends are clamps, not scroll limits — see `clampView`. */
export const MIN_VISIBLE_CANDLES = 20;
/** The widest the window gets, however much history is loaded: past this a bar is a
 * fraction of a pixel and the SVG is thousands of nodes for no readable gain. */
export const MAX_VISIBLE_CANDLES = 1500;
/** What a chart opens on: the latest stretch, as a trading terminal opens — not the whole
 * loaded history squeezed into the plot, which left nothing to drag back into. */
export const DEFAULT_VISIBLE_CANDLES = 120;
/** Empty slots kept right of the newest bar on open, so the live candle is not jammed
 * against the price axis. */
export const RIGHT_MARGIN_CANDLES = 3;
/** Dragging may carry the series past either end into empty space — as a trading chart
 * does — until this many candles are left in view. */
export const OVERSCROLL_KEEP = 5;
/** History is fetched in pages of this many candles of the current interval: one on open,
 * another each time the view nears the oldest loaded bar. */
export const HISTORY_PAGE_CANDLES = 1000;
/** Vertical drag on the price axis: zoom per pixel, as the exponent of the factor. */
const PRICE_AXIS_ZOOM_PER_PX = 0.004;
/** Horizontal drag on the time axis: zoom per pixel, as the exponent of the factor. */
const TIME_AXIS_ZOOM_PER_PX = 0.004;
/** Zoom per pixel of wheel travel, as the exponent of the factor: a 100 px mouse notch
 * zooms ~7%. A trackpad pinch (wheel events with ctrlKey) sends deltas of a few units
 * where a scroll sends tens, so it gets its own, larger rate. */
const WHEEL_ZOOM_PER_PX = 0.0007;
const PINCH_ZOOM_PER_PX = 0.005;
/** The most a single wheel event may zoom — a guard against one runaway delta. */
const MAX_ZOOM_PER_EVENT = 1.2;
/** Pixels per wheel `deltaMode` unit: lines (Firefox's mouse wheel) and pages. */
const LINE_PX = 16;
const PAGE_PX = 800;

/* -------------------------------------------------------------------------- */
/* Pure geometry — exported so tests can exercise it without a DOM.            */
/* -------------------------------------------------------------------------- */

/** The visible window, anchored to the RIGHT edge of the series: `visible` bars ending
 * `endOffset` bars before the newest one. Anchoring right (rather than storing a left
 * index) is what makes `endOffset === 0` mean "following the live candle", which is the
 * state the chart has to return to on its own as new buckets arrive. */
export interface ChartView {
  visible: number;
  endOffset: number;
}

/** The three parts of the chart that a pointer can grab, each dragging differently. */
type Region = 'plot' | 'price' | 'time';

/** The first page of history for an interval: `HISTORY_PAGE_CANDLES` of it, up to now. */
export function freshRange(intervalSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): { from: number; to: number } {
  return { from: nowSeconds - intervalSeconds * HISTORY_PAGE_CANDLES, to: nowSeconds };
}

/**
 * The widest the window may get: the whole series, or `MIN_VISIBLE_CANDLES` slots when the
 * series is shorter than that.
 *
 * That floor is the whole point. The window counts SLOTS, not candles, and bar width is
 * `plotW / visible` — so pinning `visible` to the number of candles that happen to exist
 * made width a function of history length. With two buckets the plot became two hairlines
 * four hundred pixels apart. A fixed slot count gives a fixed bar width and lets a short
 * series sit in the right-hand slots with empty space to its left, which is what every
 * trading chart does (TradingView spells the same idea `barSpacing`, and warns that
 * `fitContent()` — fit-to-data, exactly what this used to be — silently overrides it).
 */
export function maxVisible(total: number): number {
  return Math.min(MAX_VISIBLE_CANDLES, Math.max(total, MIN_VISIBLE_CANDLES));
}

/**
 * The window, made valid. Its width is held between the zoom limits; its position may run
 * past either end of the series into empty slots — a negative `endOffset` is empty space
 * right of the newest bar, an offset beyond `total - visible` empty space left of the
 * oldest — but only until `OVERSCROLL_KEEP` candles are left in view, so the series can
 * never be dragged off the plot altogether.
 *
 * It used to clamp the position to [0, total − visible], and the chart opened on the
 * whole series: the window was the series, so there was nowhere to drag it.
 */
export function clampView(view: ChartView, total: number): ChartView {
  if (total <= 0) return { visible: 0, endOffset: 0 };
  const visible = Math.min(maxVisible(total), Math.max(MIN_VISIBLE_CANDLES, Math.round(view.visible)));
  const keep = Math.min(total, OVERSCROLL_KEEP);
  const minEnd = -(visible - keep);
  const maxEnd = total - keep;
  const endOffset = Math.min(maxEnd, Math.max(minEnd, Math.round(view.endOffset)));
  return { visible, endOffset };
}

/** Where a chart opens, and where resetting the time scale returns it: the latest
 * `DEFAULT_VISIBLE_CANDLES` with a little room right of the live bar. */
export function defaultView(total: number): ChartView {
  return clampView({ visible: DEFAULT_VISIBLE_CANDLES, endOffset: -RIGHT_MARGIN_CANDLES }, total);
}

/** Zoom about the cursor: the bar under the pointer stays under the pointer. `factor > 1`
 * widens the window (zooms out). `cursorRatio` is the pointer's position across the plot,
 * 0 at the left edge, 1 at the right. */
export function zoomView(view: ChartView, total: number, factor: number, cursorRatio: number): ChartView {
  const current = clampView(view, total);
  if (total <= 0) return current;
  const ratio = Math.min(1, Math.max(0, cursorRatio));
  const anchor = total - current.visible - current.endOffset + ratio * current.visible;
  const zoomed = clampView({ visible: current.visible * factor, endOffset: current.endOffset }, total);
  const nextFirst = anchor - ratio * zoomed.visible;
  const next = clampView({ visible: zoomed.visible, endOffset: total - zoomed.visible - nextFirst }, total);
  // Once the window can hold the whole series, zooming out shows all of it rather than
  // sliding part of it off one edge into empty slots on the other.
  if (next.visible >= total) {
    return { visible: next.visible, endOffset: Math.min(0, Math.max(-(next.visible - total), next.endOffset)) };
  }
  return next;
}

/**
 * The zoom factor for one wheel event — > 1 widens the window (zooms out). Proportional to
 * how far the wheel travelled, not a fixed step per event: a trackpad sends dozens of tiny
 * events per gesture, and zooming 15% on each made a gentle two-finger stroke lurch.
 * Exponential, so equal travel in and out cancels exactly.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY;
  const exponent = px * (ctrlKey ? PINCH_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX);
  const cap = Math.log(MAX_ZOOM_PER_EVENT);
  return Math.exp(Math.max(-cap, Math.min(cap, exponent)));
}

/**
 * Applies a pending wheel zoom to the window. The window holds a whole number of candles,
 * so a trackpad's sub-1% steps would each round away to nothing; instead the factor is
 * banked (`pending`) until it moves the window, and whatever the rounding did not realise
 * stays in the bank. At either limit the bank is
 * dropped, so a gesture that reverses direction responds at once instead of first
 * unwinding zoom that could never be applied.
 */
export function applyWheelZoom(
  view: ChartView,
  total: number,
  pending: number,
  cursorRatio: number,
): { view: ChartView; pending: number } {
  const current = clampView(view, total);
  const next = zoomView(current, total, pending, cursorRatio);
  if (next.visible !== current.visible || next.endOffset !== current.endOffset) {
    // Keep what rounding did not realise: 100 candles x 1.0056 shows 101, and the 0.44 of a
    // candle it rounded up is owed back, or a run of small steps would drift wider.
    return { view: next, pending: (current.visible * pending) / next.visible };
  }
  const atFloor = pending < 1 && current.visible <= MIN_VISIBLE_CANDLES;
  const atCeiling = pending > 1 && current.visible >= maxVisible(total);
  return { view: current, pending: atFloor || atCeiling ? 1 : pending };
}

/** Pan by whole bars. Positive `deltaCandles` walks back in time (drag right). */
export function panView(view: ChartView, total: number, deltaCandles: number): ChartView {
  const current = clampView(view, total);
  return clampView({ visible: current.visible, endOffset: current.endOffset + deltaCandles }, total);
}

/** Whether the window is where the chart opened — the state the time-axis reset returns to. */
export function isDefaultView(view: ChartView, total: number): boolean {
  const v = clampView(view, total);
  const d = defaultView(total);
  return v.visible === d.visible && v.endOffset === d.endOffset;
}

/**
 * Whether the window has come within one window's width of the oldest loaded bar — time
 * to fetch the page before it, so a trader dragging back through history meets more
 * candles instead of a wall.
 */
export function wantsOlderCandles(view: ChartView, total: number): boolean {
  if (total <= 0) return false;
  const v = clampView(view, total);
  const firstSlot = total - v.visible - v.endOffset;
  return firstSlot < v.visible;
}

/**
 * How many bars arrived on the RIGHT of the series — newer than the newest one before.
 * A history page grows the series on the left and must not move a window anchored to the
 * right; a live bucket grows it on the right and must, for a trader scrolled back.
 */
export function countAppendedOnRight(prevNewest: number | null, candles: ReadonlyArray<{ t: number }>): number {
  if (prevNewest === null) return 0;
  let n = 0;
  for (let i = candles.length - 1; i >= 0 && candles[i]!.t > prevNewest; i -= 1) n += 1;
  return n;
}

/** A manually set price range, in raw 18-decimal prices. `null` in state means auto. */
export interface PriceDomain {
  min: bigint;
  max: bigint;
}

const FACTOR_SCALE = 1_000_000;

/**
 * The price range zoomed about its centre: `factor > 1` widens it (the candles shrink),
 * `< 1` narrows it (they stretch). In bigint, like every price here; the factor is a
 * float only as a ratio, applied as an integer fraction. Never narrower than a millionth
 * of the price, never below 1 wei of price (a log axis needs a positive floor).
 */
export function scalePriceDomain(domain: PriceDomain, factor: number): PriceDomain {
  const centre = (domain.min + domain.max) / 2n;
  const half = (domain.max - domain.min) / 2n;
  const ratio = BigInt(Math.max(1, Math.round(factor * FACTOR_SCALE)));
  const floor = centre > 0n ? centre / 2_000_000n : 1n;
  let nextHalf = (half * ratio) / BigInt(FACTOR_SCALE);
  if (nextHalf < floor) nextHalf = floor > 0n ? floor : 1n;
  let min = centre - nextHalf;
  const max = centre + nextHalf;
  if (min < 1n) min = 1n;
  return { min, max: max > min ? max : min + 1n };
}

/** The price range moved by a drag of `deltaPx` (down positive) over a plot `plotH` tall:
 * dragging down shows higher prices, as the content follows the pointer. */
export function panPriceDomain(domain: PriceDomain, deltaPx: number, plotH: number): PriceDomain {
  if (plotH <= 0) return domain;
  const span = domain.max - domain.min;
  const shift = (span * BigInt(Math.round(deltaPx * 1000))) / BigInt(Math.round(plotH * 1000));
  let min = domain.min + shift;
  let max = domain.max + shift;
  if (min < 1n) {
    max += 1n - min;
    min = 1n;
  }
  return { min, max };
}

/** Zoom factor for a vertical drag on the price axis: down widens the range, up narrows
 * it, as on TradingView. Exponential, so dragging back returns exactly. */
export function priceAxisZoomFactor(deltaPx: number): number {
  return Math.exp(deltaPx * PRICE_AXIS_ZOOM_PER_PX);
}

/** Zoom factor for a horizontal drag on the time axis: right widens the bars (zooms in),
 * left squeezes them. */
export function timeAxisZoomFactor(deltaPx: number): number {
  return Math.exp(-deltaPx * TIME_AXIS_ZOOM_PER_PX);
}

function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a < 0n || q * b === a ? q : q + 1n;
}

/**
 * A round 1/2/2.5/5×10ⁿ step that divides `range` into about `targetTicks` steps — in
 * bigint, because the tick values become axis LABELS and a label is money. Doing this in
 * floats and formatting the result would put a rounded double on a price axis; here the
 * ticks are exact raw prices and go through `formatMoney` like every other figure on
 * screen.
 *
 * It picks the rung whose resulting tick COUNT is closest to the target, rather than the
 * smallest rung that covers `range / target`. The textbook "round the step up" rule is
 * what d3 does, and on a typical price domain it overshoots badly: a 352-wide range asked
 * for 5 levels gets a step of 100 and draws 3. Choosing by count gets 7 at a step of 50,
 * which is what a trading axis wants. Ties go to the smaller step — more levels is the
 * more useful failure on a price scale.
 */
export function niceStep(range: bigint, targetTicks: number): bigint {
  if (range <= 0n) return 1n;
  const target = BigInt(Math.max(1, Math.floor(targetTicks)));
  const rough = ceilDiv(range, target);
  if (rough <= 0n) return 1n;
  const magnitude = 10n ** BigInt(rough.toString().length - 1);
  // 2.5×10ⁿ stays an exact integer as long as there is a tenth of the magnitude to
  // express it in; at magnitude 1 there is not, so that rung drops out.
  const unit = magnitude / 10n;
  const rungs = unit > 0n ? [10n, 20n, 25n, 50n, 100n].map((m) => unit * m) : [1n, 2n, 5n, 10n];

  let best = rungs[0]!;
  let bestDistance = -1n;
  for (const step of rungs) {
    const count = range / step;
    const distance = count > target ? count - target : target - count;
    if (bestDistance < 0n || distance < bestDistance) {
      best = step;
      bestDistance = distance;
    }
  }
  return best;
}

/** Height of the price chips on the axis (the live mark, the crosshair's close). */
const CHIP_H = 14;

/**
 * Whether an axis label at `y` is clear of every chip at `chipYs` — a label under a chip
 * is hidden, as TradingView does, rather than printed through it ("83,404.34" over
 * "83,400.00").
 */
export function labelClearOfChips(y: number, chipYs: ReadonlyArray<number | null>): boolean {
  return chipYs.every((c) => c === null || Math.abs(y - c) >= CHIP_H);
}

/** Labelled price levels inside [min, max], on round multiples of a nice step. */
export function priceTicks(min: bigint, max: bigint, targetTicks = PRICE_TICK_TARGET): bigint[] {
  if (max < min) return [];
  if (max === min) return [min];
  const step = niceStep(max - min, targetTicks);
  const ticks: bigint[] = [];
  for (let v = ceilDiv(min, step) * step; v <= max; v += step) {
    ticks.push(v);
    if (ticks.length >= 32) break; // guard: a pathological range must not hang the render
  }
  return ticks;
}

/**
 * Which bars get a time label. Strided from the RIGHT so the newest visible bar is always
 * labelled — the left edge is the one that should lose a label when the stride does not
 * divide evenly, because that is the end the eye is not anchored on.
 */
export function timeTickIndices(count: number, maxTicks: number): number[] {
  if (count <= 0 || maxTicks <= 0) return [];
  if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i);
  const stride = Math.ceil(count / maxTicks);
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i -= stride) out.push(i);
  return out.reverse();
}

/** Axis timestamp at a resolution the interval actually distinguishes: a 1d chart
 * labelled `00:00` six times says nothing. `timeZone` exists so tests are not a function
 * of the machine's clock settings; the app passes nothing and gets local time. */
export function formatAxisTime(tSeconds: number, interval: CandleInterval, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions =
    interval === '1d'
      ? { month: '2-digit', day: '2-digit' }
      : interval === '4h'
        ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
        : { hour: '2-digit', minute: '2-digit', hour12: false };
  if (timeZone) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat('en-GB', opts).format(new Date(tSeconds * 1000)).replace(', ', ' ');
}

/**
 * Widen a candle domain to keep the live mark on screen — but only when it is near. A
 * mark far outside the visible bars (a frozen feed, or a window scrolled back through a
 * gap) would otherwise flatten every candle into a line to make room for it. Beyond half
 * the visible range the mark is dropped from the domain and its line is simply not drawn;
 * the header still shows the number, so nothing is hidden, only un-plotted.
 */
export function domainWithMark(min: bigint, max: bigint, mark: bigint | null): { min: bigint; max: bigint } {
  if (mark === null) return { min, max };
  const slack = (max - min) / 2n;
  if (mark < min - slack || mark > max + slack) return { min, max };
  return { min: mark < min ? mark : min, max: mark > max ? mark : max };
}

export type ChartMode = 'candles' | 'line';

/** Where the trader's candles/line choice is remembered between visits. */
export const CHART_MODE_STORAGE_KEY = 'whitespace.chartMode';

/**
 * The line view: one path through each candle's close and the area under it, closed down
 * to `baseY` (the bottom of the plot). Pure so the geometry can be tested without a DOM.
 * Returns null for an empty series — there is no line to draw, not a zero-length one.
 */
export function closeLinePath(points: ReadonlyArray<{ x: number; y: number }>, baseY: number): { line: string; area: string } | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${last.x.toFixed(1)} ${baseY.toFixed(1)} L${first.x.toFixed(1)} ${baseY.toFixed(1)} Z`;
  return { line, area };
}

function readStoredMode(): ChartMode {
  try {
    return window.localStorage.getItem(CHART_MODE_STORAGE_KEY) === 'line' ? 'line' : 'candles';
  } catch {
    // Storage can be blocked (private mode, sandboxed frames); the default is fine.
    return 'candles';
  }
}

/* -------------------------------------------------------------------------- */

interface Layout {
  width: number;
  height: number;
  plotW: number;
  plotH: number;
}

/**
 * Candlestick chart over `/candles`, plus the live mark/index price from the
 * `price:<pairIndex>` WS channel (REST-polled fallback).
 *
 * Live, zoomable, pannable, with a crosshair readout, handled the way TradingView is: drag
 * the plot through time (and through price, once the price scale is set by hand), drag the
 * price axis up or down to stretch or squeeze the candles, drag the time axis to zoom, the
 * wheel zooms time over the plot and price over the price axis, and a double-click on an
 * axis puts it back. History loads a page at a time as the view nears the oldest bar.
 * Interval selection and the log scale toggle are both genuine, wired features. There is no depth view (a vault has no
 * book) and no indicator library, so neither is offered as a disabled button.
 *
 * WHAT THE MOCKUP HAS THAT THIS DOES NOT. terminal_design.pdf draws a dashed horizontal
 * line at a position's liquidation price. At the time this was written the app had no
 * liquidation price to draw — PositionsList and OpenPositionForm both rendered it as a
 * dash, because it depends on accrued funding and rollover state nothing here read — and
 * drawing the line anyway, at an approximation or at entry price relabelled, would put a
 * number on screen that a trader would size a stop against. So the dashed line here marks
 * the live MARK price: real, and the level the protocol actually prices against.
 *
 * That constraint is being lifted separately by `src/hooks/useLiquidationPrice.ts`, which
 * reads the figure off OstiumPairInfos. Once it has landed, the position overlay is a
 * small addition — this component already has the primitive (see the mark line and its
 * axis chip below); it needs the trader's open positions for this pair and one more line
 * per position. It is deliberately not wired here rather than done against a hook that is
 * still in flight.
 *
 * NOTHING IS INTERPOLATED. The index series starts when the API does (services/api's
 * src/indexSeries.ts), so a freshly-started stack legitimately has a handful of buckets.
 * Those are drawn as a handful of candles against a real axis, with a caption saying so —
 * never padded out to a full-looking chart.
 */
export function PriceChart({ pairIndex }: { pairIndex: number | null }) {
  // 1m, not the 1h a mature venue would default to: the index series starts when the API
  // does, so on a fresh stack the coarse intervals hold a single in-progress bucket and
  // draw as one flat mark. The shortest interval shows real movement soonest.
  const [interval, setInterval] = useState<CandleInterval>('1m');
  const [logScale, setLogScale] = useState(false);
  // Candles by default. The stored choice is applied after mount, not in the initializer,
  // so the server render and the first client render agree.
  const [mode, setModeState] = useState<ChartMode>('candles');
  useEffect(() => {
    setModeState(readStoredMode());
  }, []);
  const setMode = useCallback((next: ChartMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(CHART_MODE_STORAGE_KEY, next);
    } catch {
      // Not remembered across visits; the switch itself still works.
    }
  }, []);
  const intervalSeconds = INTERVAL_SECONDS[interval] ?? 60;
  // History a page at a time: one page of the current interval on open, the page before it
  // whenever the view nears the oldest loaded bar (see wantsOlderCandles). It used to be a
  // fixed two days — 48 bars at 1h, 2 at 1d — and nothing more could ever be reached.
  const [range, setRange] = useState(() => freshRange(intervalSeconds));
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const { candles, loading, error } = useCandles(pairIndex, interval, range.from, range.to);
  const { data: price } = usePrice(pairIndex);
  /** Set by hand from the price axis; null is auto — fitted to the visible candles. */
  const [priceDomain, setPriceDomain] = useState<PriceDomain | null>(null);

  const total = candles.length;
  const [rawView, setRawView] = useState<ChartView>({ visible: 0, endOffset: 0 });
  // The wheel handler lives in a native listener, so it reads the window through a ref, and
  // banks sub-candle zoom between events (see applyWheelZoom).
  const viewRef = useRef(rawView);
  viewRef.current = rawView;
  const pendingZoom = useRef(1);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    pointerId: number;
    region: Region;
    startX: number;
    startY: number;
    startView: ChartView;
    startDomain: PriceDomain | null;
  } | null>(null);
  const [cursorRegion, setCursorRegion] = useState<Region>('plot');
  const [dragging, setDragging] = useState(false);
  const clipId = `plot-clip-${useId().replace(/:/g, '')}`;

  /* ---- measure ---------------------------------------------------------- */
  // Real pixels, not a scaled viewBox: axis labels have to stay legible at whatever width
  // the terminal grid gives this column, and pointer maths against a 1:1 coordinate space
  // needs no conversion beyond the bounding rect's origin.
  const [width, setWidth] = useState(880);
  const [height, setHeight] = useState(CHART_HEIGHT);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const w = rect.width;
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
      // The wrap is a flex child that fills its panel, so its height is the space the
      // chart has — not something the SVG inside it decides.
      const h = rect.height;
      if (h >= MIN_MEASURED_HEIGHT) setHeight((prev) => (Math.abs(prev - h) < 0.5 ? prev : Math.floor(h)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout: Layout = useMemo(
    () => ({
      width,
      height,
      plotW: Math.max(40, width - PAD.left - PAD.right),
      plotH: Math.max(40, height - PAD.top - PAD.bottom),
    }),
    [width, height],
  );

  /* ---- view ------------------------------------------------------------- */
  const view = clampView(rawView, total);
  // `first` goes negative as soon as the window holds more slots than there are candles.
  // Those missing slots are drawn as empty space on the LEFT, so the newest bar stays
  // pinned to the right edge where a trader looks for it, rather than the series being
  // left-aligned with a void trailing it.
  //
  // The guard is not cosmetic: `Array#slice` treats a negative start as an offset from the
  // END of the array, so passing `first` straight through would quietly return a different
  // window than the one the view describes.
  const first = total - view.visible - view.endOffset;
  const leadingSlots = Math.max(0, -first);
  const sliceStart = Math.max(0, first);
  // Past the newest bar the window holds empty slots on the right; the slice stops at the
  // series' end and those slots are simply left blank.
  const sliceEnd = Math.max(sliceStart, Math.min(total, first + view.visible));
  const visibleCandles = useMemo(() => candles.slice(sliceStart, sliceEnd), [candles, sliceStart, sliceEnd]);

  // Open on the latest stretch the first time a series arrives, and again whenever it is
  // swapped wholesale (interval change empties it). After that the user owns the window.
  const seeded = useRef(false);
  useEffect(() => {
    if (total === 0) {
      seeded.current = false;
      return;
    }
    if (!seeded.current) {
      seeded.current = true;
      setRawView(defaultView(total));
    }
  }, [total]);

  // A new bucket appearing must not slide the window out from under someone who has
  // panned back to look at something. `endOffset` counts from the right, so holding the
  // view still means growing it by exactly the number of bars appended ON THE RIGHT — a
  // page of history lands on the left and must not move it at all.
  const prevNewest = useRef<number | null>(null);
  useEffect(() => {
    const appended = countAppendedOnRight(prevNewest.current, candles);
    prevNewest.current = candles.length > 0 ? candles[candles.length - 1]!.t : null;
    if (appended > 0) {
      setRawView((v) => (v.endOffset > 0 ? { ...v, endOffset: v.endOffset + appended } : v));
    }
  }, [candles]);

  // A different market is a different series: its history, its price scale.
  const prevPair = useRef(pairIndex);
  useEffect(() => {
    if (prevPair.current === pairIndex) return;
    prevPair.current = pairIndex;
    setRange(freshRange(intervalSeconds));
    setHistoryExhausted(false);
    setPriceDomain(null);
  }, [pairIndex, intervalSeconds]);

  // Fetch the page before the oldest loaded bar once the view comes near it. A fetch that
  // brings nothing older (the start of the series, or the API's per-request cap) ends it.
  const pendingPage = useRef<{ oldest: number; sawLoading: boolean } | null>(null);
  useEffect(() => {
    if (loading || historyExhausted || total === 0 || pendingPage.current !== null) return;
    if (!wantsOlderCandles(view, total)) return;
    const oldest = candles[0]!.t;
    pendingPage.current = { oldest, sawLoading: false };
    setRange({ from: oldest - intervalSeconds * HISTORY_PAGE_CANDLES, to: Math.floor(Date.now() / 1000) });
  }, [loading, historyExhausted, total, view, candles, intervalSeconds]);
  useEffect(() => {
    const pending = pendingPage.current;
    if (!pending) return;
    if (loading) {
      pending.sawLoading = true;
      return;
    }
    if (!pending.sawLoading) return;
    pendingPage.current = null;
    if (candles.length === 0 || candles[0]!.t >= pending.oldest) setHistoryExhausted(true);
  }, [loading, candles]);

  const step = view.visible > 0 ? layout.plotW / view.visible : 0;

  const ratioFromClientX = useCallback(
    (clientX: number) => {
      const el = svgRef.current;
      if (!el || layout.plotW <= 0) return 0.5;
      const rect = el.getBoundingClientRect();
      const scale = rect.width > 0 ? layout.width / rect.width : 1;
      return ((clientX - rect.left) * scale - PAD.left) / layout.plotW;
    },
    [layout],
  );

  /** Which part of the chart a pointer is over: the plot, the price axis on the right, or
   * the time axis along the bottom. Each one drags differently. */
  const regionAt = useCallback(
    (clientX: number, clientY: number): Region => {
      const el = svgRef.current;
      if (!el) return 'plot';
      const rect = el.getBoundingClientRect();
      const sx = rect.width > 0 ? layout.width / rect.width : 1;
      const sy = rect.height > 0 ? layout.height / rect.height : 1;
      const x = (clientX - rect.left) * sx;
      const y = (clientY - rect.top) * sy;
      if (x > PAD.left + layout.plotW) return 'price';
      if (y > PAD.top + layout.plotH) return 'time';
      return 'plot';
    },
    [layout],
  );

  /* ---- wheel zoom ------------------------------------------------------- */
  // Native, non-passive: React routes wheel through a passive root listener, so
  // preventDefault from an onWheel prop is ignored and the page scrolls instead.
  // The native listener reads the price scale through refs too: the domain set by hand, or
  // the auto one it starts from.
  const priceDomainRef = useRef(priceDomain);
  priceDomainRef.current = priceDomain;
  const autoDomainRef = useRef<PriceDomain | null>(null);
  const stepRef = useRef(0);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 && event.deltaX === 0) return;
      event.preventDefault();
      // Over the price axis the wheel stretches or squeezes the price scale.
      if (regionAt(event.clientX, event.clientY) === 'price') {
        const base = priceDomainRef.current ?? autoDomainRef.current;
        if (base) setPriceDomain(scalePriceDomain(base, wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey)));
        return;
      }
      // A sideways swipe (trackpad, shift-wheel) pans through time; the content follows it.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        if (stepRef.current <= 0) return;
        const next = clampView({ ...viewRef.current, endOffset: viewRef.current.endOffset - event.deltaX / stepRef.current }, total);
        viewRef.current = next;
        setRawView(next);
        return;
      }
      const pending = pendingZoom.current * wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey);
      const step = applyWheelZoom(viewRef.current, total, pending, ratioFromClientX(event.clientX));
      pendingZoom.current = step.pending;
      if (step.view !== viewRef.current) {
        viewRef.current = step.view;
        setRawView(step.view);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [total, ratioFromClientX, regionAt]);

  /* ---- drag pan + crosshair --------------------------------------------- */
  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (total === 0) return;
    const region = regionAt(event.clientX, event.clientY);
    const autoDomain = autoDomainRef.current;
    drag.current = {
      pointerId: event.pointerId,
      region,
      startX: event.clientX,
      startY: event.clientY,
      startView: view,
      // The price axis always drags a domain — the one set by hand, or the auto one it
      // takes over from. The plot moves through price only once a domain is set by hand.
      startDomain: region === 'price' ? (priceDomain ?? autoDomain) : priceDomain,
    };
    setDragging(true);
    setHover(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d && d.pointerId === event.pointerId) {
      const dx = event.clientX - d.startX;
      const dy = event.clientY - d.startY;
      if (d.region === 'price') {
        if (d.startDomain) setPriceDomain(scalePriceDomain(d.startDomain, priceAxisZoomFactor(dy)));
        return;
      }
      if (d.region === 'time') {
        setRawView(zoomView(d.startView, total, timeAxisZoomFactor(dx), 1));
        return;
      }
      if (step > 0) setRawView(clampView({ ...d.startView, endOffset: d.startView.endOffset + dx / step }, total));
      if (d.startDomain) setPriceDomain(panPriceDomain(d.startDomain, dy, layout.plotH));
      return;
    }
    const region = regionAt(event.clientX, event.clientY);
    if (region !== cursorRegion) setCursorRegion(region);
    if (region !== 'plot') {
      setHover(null);
      return;
    }
    if (step <= 0) return;
    // Pointer position resolves to a slot; subtract the empty leading slots to get the
    // candle index. Hovering the blank left-hand area must clear the crosshair, not clamp
    // it onto the oldest bar.
    const idx = Math.floor(ratioFromClientX(event.clientX) * view.visible) - leadingSlots;
    setHover(idx >= 0 && idx < visibleCandles.length ? idx : null);
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d && d.pointerId === event.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      drag.current = null;
      setDragging(false);
    }
  };

  /** A double-click on an axis puts that axis back: the price scale to auto, the time
   * scale to where the chart opened. */
  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const region = regionAt(event.clientX, event.clientY);
    if (region === 'price') setPriceDomain(null);
    else if (region === 'time') setRawView(defaultView(total));
  };

  /* ---- scale ------------------------------------------------------------ */
  const markRaw = price ? priceToRaw(price.mark) : null;

  const scale = useMemo(() => {
    if (visibleCandles.length === 0) return null;
    let lo = priceToRaw(visibleCandles[0]!.l);
    let hi = priceToRaw(visibleCandles[0]!.h);
    for (const c of visibleCandles) {
      const l = priceToRaw(c.l);
      const h = priceToRaw(c.h);
      if (l < lo) lo = l;
      if (h > hi) hi = h;
    }
    const domain = domainWithMark(lo, hi, markRaw);
    // A flat series has no range to divide by; give it a symmetric band so the bars land
    // mid-plot instead of on the floor.
    const pad = domain.max === domain.min ? (domain.max === 0n ? 1n : domain.max / 1000n) : (domain.max - domain.min) / 24n;
    const autoMin = domain.min - pad;
    const autoMax = domain.max + pad;
    // A range set by hand on the price axis wins over the fit until it is reset.
    let min = priceDomain ? priceDomain.min : autoMin;
    const max = priceDomain ? priceDomain.max : autoMax;
    if (logScale && min < 1n) min = 1n;

    // Display-only pixel-position math: converting an exact bigint price to a JS number
    // ratio here is safe because the result never reaches a money formatter or a
    // transaction — only an SVG y-coordinate. See src/lib/money.ts's module doc for the
    // boundary this project draws around bigint-only money handling.
    const loN = logScale ? Math.log(Number(min)) : Number(min);
    const hiN = logScale ? Math.log(Number(max)) : Number(max);
    const toY = (value: bigint) => {
      const v = logScale ? Math.log(Number(value)) : Number(value);
      const ratio = hiN === loN ? 0.5 : (v - loN) / (hiN - loN);
      return PAD.top + layout.plotH - ratio * layout.plotH;
    };
    return { min, max, toY, auto: { min: autoMin, max: autoMax } };
  }, [visibleCandles, logScale, layout.plotH, markRaw, priceDomain]);
  autoDomainRef.current = scale ? scale.auto : null;
  stepRef.current = step;

  /** Centre of a slot, counted from the left edge of the plot. */
  const xOf = (slot: number) => PAD.left + (slot + 0.5) * step;
  /** Centre of the slot a visible candle sits in, past however many slots lead it. */
  const xOfCandle = (i: number) => xOf(leadingSlots + i);

  const geometry = useMemo(() => {
    if (!scale) return [];
    // 62% of the slot, the same fill ratio the design used before. The upper bound exists
    // only to stop a body ballooning when a slot is very wide; now that the window never
    // holds fewer than MIN_VISIBLE_CANDLES slots, `step` is capped at `plotW / 20` (~40px
    // on a full-width pane) and the ratio governs throughout. The old 16px ceiling clipped
    // that to a 40%-filled slot, which read as thin and gappy at the minimum zoom.
    const bodyWidth = Math.max(1, Math.min(26, step * 0.62));
    return visibleCandles.map((c, i) => {
      const open = priceToRaw(c.o);
      const close = priceToRaw(c.c);
      const up = close >= open;
      const bodyTop = scale.toY(up ? close : open);
      const bodyBottom = scale.toY(up ? open : close);
      return {
        key: c.t,
        x: PAD.left + (leadingSlots + i + 0.5) * step,
        wickTop: scale.toY(priceToRaw(c.h)),
        wickBottom: scale.toY(priceToRaw(c.l)),
        bodyY: Math.min(bodyTop, bodyBottom),
        bodyH: Math.max(1, Math.abs(bodyBottom - bodyTop)),
        bodyWidth,
        up,
      };
    });
  }, [visibleCandles, scale, step, leadingSlots]);

  const linePath = useMemo(
    () =>
      mode === 'line' && scale
        ? closeLinePath(
            geometry.map((c, i) => ({ x: c.x, y: scale.toY(priceToRaw(visibleCandles[i]!.c)) })),
            PAD.top + layout.plotH,
          )
        : null,
    [mode, scale, geometry, visibleCandles, layout.plotH],
  );
  const lastLinePoint =
    linePath && scale && visibleCandles.length > 0
      ? { x: geometry[geometry.length - 1]!.x, y: scale.toY(priceToRaw(visibleCandles[visibleCandles.length - 1]!.c)) }
      : null;

  const yTicks = useMemo(() => (scale ? priceTicks(scale.min, scale.max) : []), [scale]);
  const xTicks = useMemo(() => timeTickIndices(visibleCandles.length, TIME_TICK_TARGET), [visibleCandles.length]);

  const hovered: Candle | null = hover !== null ? (visibleCandles[hover] ?? null) : null;
  // The close it snaps to, when that is on the plot: with a price range set by hand the
  // hovered candle's close can sit above or below it, and its chip has nowhere to go.
  const crosshairY = (() => {
    if (!hovered || !scale) return null;
    const y = scale.toY(priceToRaw(hovered.c));
    return y >= PAD.top && y <= PAD.top + layout.plotH ? y : null;
  })();
  const markY = scale && markRaw !== null && markRaw >= scale.min && markRaw <= scale.max ? scale.toY(markRaw) : null;

  const now = Math.floor(Date.now() / 1000);
  const newest = candles[total - 1];
  // "Stale" = the live bucket stopped advancing. Worth saying out loud: a chart that has
  // simply stopped receiving data looks identical to a quiet market, and only one of
  // those is a reason to distrust the price next to it.
  const staleBuckets = newest ? Math.floor((now - newest.t) / intervalSeconds) : 0;

  return (
    <div data-testid="price-chart">
      <div className="chart-toolbar">
        <div className="group" data-testid="interval-group">
          {INTERVALS.map((i) => (
            <button
              key={i}
              type="button"
              className={interval === i ? 'active' : ''}
              onClick={() => {
                setInterval(i);
                setRange(freshRange(INTERVAL_SECONDS[i] ?? 60));
                setHistoryExhausted(false);
                setPriceDomain(null);
                seeded.current = false;
                setHover(null);
              }}
              data-testid={`interval-${i}`}
            >
              {i.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="group">
          <div className="group mode-toggle" role="group" aria-label="Chart type">
            <button
              type="button"
              className={mode === 'candles' ? 'active' : ''}
              aria-pressed={mode === 'candles'}
              onClick={() => setMode('candles')}
              data-testid="chart-mode-candles"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M7 3v4M7 17v4M17 3v6M17 15v6" />
                <rect x="4" y="7" width="6" height="10" rx="1" />
                <rect x="14" y="9" width="6" height="6" rx="1" />
              </svg>
              Candles
            </button>
            <button
              type="button"
              className={mode === 'line' ? 'active' : ''}
              aria-pressed={mode === 'line'}
              onClick={() => setMode('line')}
              data-testid="chart-mode-line"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 17l5-6 4 3 5-7 4 4" />
              </svg>
              Line
            </button>
          </div>
          <button type="button" className={logScale ? 'active' : ''} onClick={() => setLogScale((v) => !v)} data-testid="log-scale-toggle">
            Log
          </button>
          {/* Lit while the price scale fits the candles; dark once it has been dragged by hand,
              and pressing it fits it again — as TradingView's "auto" does. */}
          <button
            type="button"
            className={priceDomain === null ? 'active' : ''}
            aria-pressed={priceDomain === null}
            onClick={() => setPriceDomain(null)}
            title="Fit the price scale to the candles in view"
            data-testid="price-auto"
          >
            Auto
          </button>
        </div>
      </div>

      {/* The mark/index readout that used to sit here was a second copy of what
          MarketHeaderBar shows directly above it — the reference prints the price once.
          `data-testid="mark-price"` moved onto the header's price with it. */}
      {price && price.degraded ? (
        <DegradedBanner healthyVenues={price.healthyVenues} minHealthyVenues={price.minHealthyVenues} />
      ) : null}

      <div className="chart-area">
        {/* Only for the first load: a page of older history arriving under a chart someone is
            dragging must not push a line of text in above it. */}
        {loading && total === 0 ? <p>Loading candles…</p> : null}
        {error ? <p className="error-text">Failed to load candles: {error.message}</p> : null}
        {!loading && !error && total === 0 ? (
          <p className={styles.empty} data-testid="chart-empty">
            No candle data yet — the index series begins when the API starts, so this fills in as buckets close.
          </p>
        ) : null}

        <div className={styles.wrap} ref={wrapRef}>
          {scale && total > 0 ? (
            <>
              <svg
                ref={svgRef}
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                role="img"
                aria-label={`Price chart, ${visibleCandles.length} of ${total} candles`}
                className={styles.svg}
                data-testid="price-svg"
                data-visible-candles={visibleCandles.length}
                data-total-candles={total}
                data-first-t={visibleCandles[0]?.t}
                data-last-t={visibleCandles[visibleCandles.length - 1]?.t}
                data-price-min={scale.min.toString()}
                data-price-max={scale.max.toString()}
                data-price-auto={priceDomain === null}
                style={{
                  cursor:
                    cursorRegion === 'price' ? 'ns-resize' : cursorRegion === 'time' ? 'ew-resize' : dragging ? 'grabbing' : 'crosshair',
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onDoubleClick={onDoubleClick}
                onPointerLeave={(e) => {
                  if (!drag.current) setHover(null);
                }}
              >
                <defs>
                  {/* Candles dragged past the plot's edges, by time or by a price range set
                      by hand, are cut at the plot rather than painted over the axes. */}
                  <clipPath id={clipId}>
                    <rect x={PAD.left} y={PAD.top} width={layout.plotW} height={layout.plotH} />
                  </clipPath>
                </defs>
                {/* Grid first, so every stroke below paints over it. */}
                <g className={styles.grid} data-testid="chart-grid">
                  {yTicks.map((t) => (
                    <line key={`h${t}`} x1={PAD.left} x2={PAD.left + layout.plotW} y1={scale.toY(t)} y2={scale.toY(t)} />
                  ))}
                  {xTicks.map((i) => (
                    <line key={`v${i}`} x1={xOfCandle(i)} x2={xOfCandle(i)} y1={PAD.top} y2={PAD.top + layout.plotH} />
                  ))}
                </g>

                <g className={styles.axis} data-testid="price-axis">
                  {yTicks
                    .filter((t) => labelClearOfChips(scale.toY(t), [markY, crosshairY]))
                    .map((t) => (
                      <text key={`yl${t}`} x={PAD.left + layout.plotW + 6} y={scale.toY(t) + 3.5}>
                        {formatMoney(t, PRICE_DECIMALS_NUM)}
                      </text>
                    ))}
                </g>

                <g className={`${styles.axis} ${styles.axisTime}`} data-testid="time-axis">
                  {xTicks.map((i) => {
                    const c = visibleCandles[i];
                    return c ? (
                      <text key={`xl${c.t}`} x={xOfCandle(i)} y={layout.height - 8}>
                        {formatAxisTime(c.t, interval)}
                      </text>
                    ) : null;
                  })}
                </g>

                {mode === 'candles' ? (
                  <g data-testid="chart-candles" clipPath={`url(#${clipId})`}>
                    {geometry.map((c) => (
                      <g key={c.key} className={c.up ? styles.up : styles.down}>
                        <line x1={c.x} x2={c.x} y1={c.wickTop} y2={c.wickBottom} />
                        <rect x={c.x - c.bodyWidth / 2} y={c.bodyY} width={c.bodyWidth} height={c.bodyH} />
                      </g>
                    ))}
                  </g>
                ) : null}

                {mode === 'line' && linePath ? (
                  <g data-testid="chart-line" clipPath={`url(#${clipId})`}>
                    <path className={styles.lineArea} d={linePath.area} />
                    <path className={styles.line} d={linePath.line} />
                    {lastLinePoint ? <circle className={styles.lineDot} cx={lastLinePoint.x} cy={lastLinePoint.y} r={3.5} /> : null}
                  </g>
                ) : null}

                {markY !== null && price ? (
                  <g data-testid="mark-price-line">
                    <line className={styles.markLine} x1={PAD.left} x2={PAD.left + layout.plotW} y1={markY} y2={markY} clipPath={`url(#${clipId})`} />
                    <rect className={styles.markChip} x={PAD.left + layout.plotW + 2} y={markY - CHIP_H / 2} width={PAD.right - 6} height={CHIP_H} rx={5} />
                    <text className={styles.markChipText} x={PAD.left + layout.plotW + 6} y={markY + 3.5}>
                      {formatMoney(price.mark, PRICE_DECIMALS_NUM)}
                    </text>
                  </g>
                ) : null}

                {/* The crosshair SNAPS to the hovered candle: vertical to its centre,
                    horizontal to its close. Tracking the raw pointer y would mean turning
                    a pixel back into a price to label it, i.e. inventing a monetary value
                    out of a float — see src/lib/money.ts. Snapping keeps every number on
                    this chart one the API actually sent. */}
                {hovered && hover !== null && crosshairY !== null ? (
                  <g data-testid="crosshair">
                    <line className={styles.crosshair} x1={xOfCandle(hover)} x2={xOfCandle(hover)} y1={PAD.top} y2={PAD.top + layout.plotH} />
                    <line
                      clipPath={`url(#${clipId})`}
                      className={styles.crosshair}
                      x1={PAD.left}
                      x2={PAD.left + layout.plotW}
                      y1={scale.toY(priceToRaw(hovered.c))}
                      y2={scale.toY(priceToRaw(hovered.c))}
                    />
                    <rect
                      className={styles.crosshairChip}
                      x={PAD.left + layout.plotW + 2}
                      y={scale.toY(priceToRaw(hovered.c)) - 7}
                      width={PAD.right - 6}
                      height={14}
                      rx={5}
                    />
                    <text
                      className={styles.crosshairChipText}
                      x={PAD.left + layout.plotW + 6}
                      y={scale.toY(priceToRaw(hovered.c)) + 3.5}
                    >
                      {formatMoney(hovered.c, PRICE_DECIMALS_NUM)}
                    </text>
                  </g>
                ) : null}
              </svg>

              <div className={styles.readout} data-testid="crosshair-readout">
                {hovered ? (
                  <>
                    <span className={styles.readoutTime}>{formatAxisTime(hovered.t, interval)}</span>
                    <span>
                      O <b>{formatMoney(hovered.o, PRICE_DECIMALS_NUM)}</b>
                    </span>
                    <span>
                      H <b>{formatMoney(hovered.h, PRICE_DECIMALS_NUM)}</b>
                    </span>
                    <span>
                      L <b>{formatMoney(hovered.l, PRICE_DECIMALS_NUM)}</b>
                    </span>
                    <span className={priceToRaw(hovered.c) >= priceToRaw(hovered.o) ? styles.upText : styles.downText}>
                      C <b>{formatMoney(hovered.c, PRICE_DECIMALS_NUM)}</b>
                    </span>
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        {total > 0 && total < MIN_VISIBLE_CANDLES ? (
          <p className={styles.note} data-testid="chart-sparse-note">
            Only {total} {total === 1 ? 'bucket' : 'buckets'} of history so far — the index series starts with the API and
            is not backfilled. Nothing here is padded or interpolated.
          </p>
        ) : null}
        {staleBuckets >= 3 ? (
          <p className={styles.note} data-testid="chart-stale-note">
            Last bucket closed {staleBuckets} ×{interval} ago — the index feed has stopped advancing, so this chart is
            showing the most recent real data, not a quiet market.
          </p>
        ) : null}
      </div>
    </div>
  );
}
