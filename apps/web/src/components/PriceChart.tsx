'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

const CHART_HEIGHT = 340;
/** Right gutter holds the price axis, bottom gutter the time axis. The plot is what is
 * left; everything below is expressed against it so a resize moves one number. */
const PAD = { top: 10, right: 66, bottom: 24, left: 8 } as const;
const PRICE_TICK_TARGET = 5;
const TIME_TICK_TARGET = 6;
/** Below this the bars are too thin to read as candles; above `total` there is nothing
 * left to show. Both ends are clamps, not scroll limits — see `clampView`. */
export const MIN_VISIBLE_CANDLES = 20;
const ZOOM_STEP = 1.15;

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
  return Math.max(total, MIN_VISIBLE_CANDLES);
}

export function clampView(view: ChartView, total: number): ChartView {
  if (total <= 0) return { visible: 0, endOffset: 0 };
  const visible = Math.min(maxVisible(total), Math.max(MIN_VISIBLE_CANDLES, Math.round(view.visible)));
  // `total - visible` goes negative once the window is wider than the series; a window
  // that already shows everything has nowhere to scroll, so the range collapses to [0, 0].
  const endOffset = Math.min(Math.max(0, total - visible), Math.max(0, Math.round(view.endOffset)));
  return { visible, endOffset };
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
  return clampView({ visible: zoomed.visible, endOffset: total - zoomed.visible - nextFirst }, total);
}

/** Pan by whole bars. Positive `deltaCandles` walks back in time (drag right). */
export function panView(view: ChartView, total: number, deltaCandles: number): ChartView {
  const current = clampView(view, total);
  return clampView({ visible: current.visible, endOffset: current.endOffset + deltaCandles }, total);
}

/** "Everything, pinned to the live edge" — the state the reset affordance returns to. */
export function isDefaultView(view: ChartView, total: number): boolean {
  const v = clampView(view, total);
  return v.visible === maxVisible(total) && v.endOffset === 0;
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

/* -------------------------------------------------------------------------- */

interface Layout {
  width: number;
  plotW: number;
  plotH: number;
}

/**
 * Candlestick chart over `/candles`, plus the live mark/index price from the
 * `price:<pairIndex>` WS channel (REST-polled fallback).
 *
 * Live, zoomable, pannable, with a crosshair readout. Interval selection and the log
 * scale toggle are both genuine, wired features; DEPTH/INDICATORS have no backing
 * implementation and are rendered disabled rather than omitted (matching the mockup's
 * intended affordance without pretending they work).
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
  const now = useMemo(() => Math.floor(Date.now() / 1000), []);
  const from = now - 60 * 60 * 24 * 2; // 2 days back
  const { candles, loading, error } = useCandles(pairIndex, interval, from, now);
  const { data: price } = usePrice(pairIndex);

  const total = candles.length;
  const [rawView, setRawView] = useState<ChartView>({ visible: 0, endOffset: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startEndOffset: number; moved: boolean } | null>(null);

  /* ---- measure ---------------------------------------------------------- */
  // Real pixels, not a scaled viewBox: axis labels have to stay legible at whatever width
  // the terminal grid gives this column, and pointer maths against a 1:1 coordinate space
  // needs no conversion beyond the bounding rect's origin.
  const [width, setWidth] = useState(880);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
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
      plotW: Math.max(40, width - PAD.left - PAD.right),
      plotH: Math.max(40, CHART_HEIGHT - PAD.top - PAD.bottom),
    }),
    [width],
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
  const visibleCandles = useMemo(
    () => candles.slice(sliceStart, sliceStart + view.visible - leadingSlots),
    [candles, sliceStart, view.visible, leadingSlots],
  );

  // Show the whole series the first time one arrives, and again whenever the series is
  // swapped wholesale (interval change empties it). After that the user owns the window.
  const seeded = useRef(false);
  useEffect(() => {
    if (total === 0) {
      seeded.current = false;
      return;
    }
    if (!seeded.current) {
      seeded.current = true;
      setRawView({ visible: maxVisible(total), endOffset: 0 });
    }
  }, [total]);

  // A new bucket appearing must not slide the window out from under someone who has
  // panned back to look at something. `endOffset` counts from the right, so holding the
  // view still means growing it by exactly the number of bars that were appended.
  const prevTotal = useRef(total);
  useEffect(() => {
    const appended = total - prevTotal.current;
    prevTotal.current = total;
    if (appended > 0) {
      setRawView((v) => (v.endOffset > 0 ? { ...v, endOffset: v.endOffset + appended } : v));
    }
  }, [total]);

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

  /* ---- wheel zoom ------------------------------------------------------- */
  // Native, non-passive: React routes wheel through a passive root listener, so
  // preventDefault from an onWheel prop is ignored and the page scrolls instead.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const factor = event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const ratio = ratioFromClientX(event.clientX);
      setRawView((v) => zoomView(v, total, factor, ratio));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [total, ratioFromClientX]);

  /* ---- drag pan + crosshair --------------------------------------------- */
  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (total === 0) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startEndOffset: view.endOffset, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d && d.pointerId === event.pointerId) {
      if (step <= 0) return;
      const deltaCandles = (event.clientX - d.startX) / step;
      if (Math.abs(event.clientX - d.startX) > 2) d.moved = true;
      setRawView((v) => panView({ ...v, endOffset: d.startEndOffset + deltaCandles }, total, 0));
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
    }
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
    const min = domain.min - pad;
    const max = domain.max + pad;

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
    return { min, max, toY };
  }, [visibleCandles, logScale, layout.plotH, markRaw]);

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

  const yTicks = useMemo(() => (scale ? priceTicks(scale.min, scale.max) : []), [scale]);
  const xTicks = useMemo(() => timeTickIndices(visibleCandles.length, TIME_TICK_TARGET), [visibleCandles.length]);

  const hovered: Candle | null = hover !== null ? (visibleCandles[hover] ?? null) : null;
  const markY = scale && markRaw !== null && markRaw >= scale.min && markRaw <= scale.max ? scale.toY(markRaw) : null;

  const intervalSeconds = INTERVAL_SECONDS[interval] ?? 60;
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
          <button type="button" disabled title="Not implemented">
            Depth
          </button>
          <button type="button" disabled title="Not implemented">
            Indicators
          </button>
          <button type="button" className={logScale ? 'active' : ''} onClick={() => setLogScale((v) => !v)} data-testid="log-scale-toggle">
            Log scale
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
        {loading ? <p>Loading candles…</p> : null}
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
                height={CHART_HEIGHT}
                viewBox={`0 0 ${layout.width} ${CHART_HEIGHT}`}
                role="img"
                aria-label={`Price chart, ${visibleCandles.length} of ${total} candles`}
                className={styles.svg}
                data-testid="price-svg"
                data-visible-candles={visibleCandles.length}
                data-total-candles={total}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onPointerLeave={(e) => {
                  endDrag(e);
                  setHover(null);
                }}
              >
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
                  {yTicks.map((t) => (
                    <text key={`yl${t}`} x={PAD.left + layout.plotW + 6} y={scale.toY(t) + 3.5}>
                      {formatMoney(t, PRICE_DECIMALS_NUM)}
                    </text>
                  ))}
                </g>

                <g className={`${styles.axis} ${styles.axisTime}`} data-testid="time-axis">
                  {xTicks.map((i) => {
                    const c = visibleCandles[i];
                    return c ? (
                      <text key={`xl${c.t}`} x={xOfCandle(i)} y={CHART_HEIGHT - 8}>
                        {formatAxisTime(c.t, interval)}
                      </text>
                    ) : null;
                  })}
                </g>

                {geometry.map((c) => (
                  <g key={c.key} className={c.up ? styles.up : styles.down}>
                    <line x1={c.x} x2={c.x} y1={c.wickTop} y2={c.wickBottom} />
                    <rect x={c.x - c.bodyWidth / 2} y={c.bodyY} width={c.bodyWidth} height={c.bodyH} />
                  </g>
                ))}

                {markY !== null && price ? (
                  <g data-testid="mark-price-line">
                    <line className={styles.markLine} x1={PAD.left} x2={PAD.left + layout.plotW} y1={markY} y2={markY} />
                    <rect className={styles.markChip} x={PAD.left + layout.plotW + 2} y={markY - 7} width={PAD.right - 6} height={14} rx={2} />
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
                {hovered && hover !== null ? (
                  <g data-testid="crosshair">
                    <line className={styles.crosshair} x1={xOfCandle(hover)} x2={xOfCandle(hover)} y1={PAD.top} y2={PAD.top + layout.plotH} />
                    <line
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
                      rx={2}
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
