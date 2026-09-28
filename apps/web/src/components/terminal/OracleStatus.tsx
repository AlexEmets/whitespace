'use client';

import { useEffect, useState } from 'react';
import { usePrice } from '@/hooks/usePrice';
import { useProtocolParams } from '@/hooks/useProtocolParams';

/** Short venue codes, so three venue names fit on one line of a 208px rail. Unknown venues
 * fall back to their own name upper-cased rather than being dropped. */
const VENUE_CODE: Record<string, string> = {
  binance: 'BIN',
  bybit: 'BYB',
  okx: 'OKX',
  whitebit: 'WBT',
};

export function venueCode(name: string): string {
  return VENUE_CODE[name.toLowerCase()] ?? name.toUpperCase();
}

/** Whole seconds since `updatedAt` (unix seconds), never negative: a publisher clock a
 * little ahead of this browser's must not render as "-1 s". */
export function reportAgeSeconds(updatedAt: number, nowMs: number): number {
  return Math.max(0, Math.floor(nowMs / 1000 - updatedAt));
}

/**
 * The oracle card at the foot of the terminal rail: how many signatures a price needs
 * (k of N, read from the verifier contract), which exchange venues the publisher is
 * currently healthy on, and how old the last price is. Every figure is real — the quorum
 * comes from `useProtocolParams`, the venues and age from the live price payload — and an
 * unknown one renders as a dash, not as the design's example numbers.
 */
export function OracleStatus({ pairIndex }: { pairIndex: number | null }) {
  const { data: price } = usePrice(pairIndex);
  const { threshold, signerCount, maxAgeSeconds } = useProtocolParams();

  // The age has to tick between price updates, or a feed that stopped would keep showing
  // the age it had when it stopped.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const k = threshold !== null ? Number(threshold) : null;
  const n = signerCount !== null ? Number(signerCount) : null;
  const venues = price?.healthyVenues ?? null;
  const age = price ? reportAgeSeconds(price.updatedAt, now) : null;
  const stale = age !== null && maxAgeSeconds !== null && age > maxAgeSeconds;

  return (
    <div className="rail-card" data-testid="oracle-status">
      <div className="rail-card-title">
        <span>Oracle</span>
        {k !== null && n !== null && n > 0 && n <= 16 ? (
          <span className="signer-dots" aria-label={`${k} of ${n} signatures required`}>
            {Array.from({ length: n }, (_, i) => (
              <span key={i} className={i < k ? 'on' : undefined} />
            ))}
          </span>
        ) : null}
      </div>
      <div className="rail-card-row">
        <span>Signed</span>
        <span data-testid="oracle-quorum">{k !== null && n !== null ? `${k} of ${n}` : '—'}</span>
      </div>
      <div className="rail-card-row">
        <span>Venues</span>
        <span data-testid="oracle-venues" className={price?.degraded ? 'neg' : undefined}>
          {venues && venues.length > 0 ? venues.map(venueCode).join(' · ') : '—'}
        </span>
      </div>
      <div className="rail-card-row">
        <span>Last report</span>
        <span data-testid="oracle-age" className={stale ? 'neg' : undefined}>
          {age !== null ? `${age}s ago` : '—'}
        </span>
      </div>
    </div>
  );
}
