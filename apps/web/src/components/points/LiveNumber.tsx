'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { formatMoney } from '@/lib/money';

const PD = 6; // points decimals

/**
 * A points counter that glides through the current second instead of jumping once a second.
 *
 * The page's clock ticks on each whole second `startMs / 1000`; this shows the value moving
 * from `from` (the ledger one second ago) to `to` (the ledger now) across that second, so it
 * trails the ledger by under a second and never runs ahead of it. The motion is a
 * requestAnimationFrame loop writing the two text nodes directly — no React render per frame,
 * no request of any kind, and the browser parks it on a hidden tab. It stops once the second
 * is over and the next tick starts it again.
 */
export function LiveNumber({
  from,
  to,
  startMs,
  dp,
  fracClassName,
}: {
  from: bigint;
  to: bigint;
  startMs: number;
  dp: number;
  fracClassName?: string;
}) {
  const wholeRef = useRef<HTMLSpanElement>(null);
  const fracRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    paint(wholeRef.current, fracRef.current, valueAt(from, to, startMs, Date.now()), dp);
  }, [from, to, startMs, dp]);

  useEffect(() => {
    if (to === from) return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let last = '';
    const step = () => {
      const now = Date.now();
      const text = format(valueAt(from, to, startMs, now), dp);
      if (text !== last) {
        last = text;
        write(wholeRef.current, fracRef.current, text);
      }
      if (now - startMs < 1000) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [from, to, startMs, dp]);

  // Empty on purpose: the text is written by the effects above, and React never renders it,
  // so a re-render cannot put back a stale figure over one the animation wrote.
  return (
    <span>
      <span ref={wholeRef} />
      <span ref={fracRef} className={fracClassName} />
    </span>
  );
}

/** Where the counter stands at `nowMs`, interpolated in integer points units. */
export function valueAt(from: bigint, to: bigint, startMs: number, nowMs: number): bigint {
  const progress = Math.min(1, Math.max(0, (nowMs - startMs) / 1000));
  return from + ((to - from) * BigInt(Math.round(progress * 1000))) / 1000n;
}

function format(raw: bigint, dp: number): string {
  return formatMoney(raw, PD, { fractionDigits: dp });
}

function paint(whole: HTMLElement | null, frac: HTMLElement | null, raw: bigint, dp: number) {
  write(whole, frac, format(raw, dp));
}

function write(whole: HTMLElement | null, frac: HTMLElement | null, text: string) {
  const dot = text.indexOf('.');
  if (whole) whole.textContent = dot === -1 ? text : text.slice(0, dot);
  if (frac) frac.textContent = dot === -1 ? '' : text.slice(dot);
}
