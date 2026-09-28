import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OracleStatus, reportAgeSeconds, venueCode } from '@/components/terminal/OracleStatus';

interface Params {
  threshold: bigint | null;
  signerCount: bigint | null;
  maxAgeSeconds: number | null;
}

let price: Record<string, unknown> | undefined;
let params: Params;

vi.mock('@/hooks/usePrice', () => ({ usePrice: () => ({ data: price }) }));
vi.mock('@/hooks/useProtocolParams', () => ({ useProtocolParams: () => params }));

const NOW_S = 1_790_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_S * 1000);
  params = { threshold: 3n, signerCount: 5n, maxAgeSeconds: 10 };
  price = { updatedAt: NOW_S - 2, healthyVenues: ['bybit', 'okx', 'binance'], degraded: false };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reportAgeSeconds', () => {
  it('counts whole seconds since the report', () => {
    expect(reportAgeSeconds(100, 103_900)).toBe(3);
  });

  it('never goes negative when the publisher clock is ahead of the browser', () => {
    expect(reportAgeSeconds(105, 103_000)).toBe(0);
  });
});

describe('venueCode', () => {
  it('abbreviates known venues and upper-cases unknown ones instead of dropping them', () => {
    expect(venueCode('binance')).toBe('BIN');
    expect(venueCode('Bybit')).toBe('BYB');
    expect(venueCode('kraken')).toBe('KRAKEN');
  });
});

describe('<OracleStatus>', () => {
  it('shows the on-chain quorum as k of N with one lit dot per required signature', () => {
    render(<OracleStatus pairIndex={0} />);
    expect(screen.getByTestId('oracle-quorum')).toHaveTextContent('3 of 5');
    const dots = screen.getByLabelText('3 of 5 signatures required').querySelectorAll('span');
    expect(dots).toHaveLength(5);
    expect(Array.from(dots).filter((d) => d.className === 'on')).toHaveLength(3);
  });

  it('dashes the quorum when the verifier could not be read, rather than printing the design default', () => {
    params = { threshold: null, signerCount: null, maxAgeSeconds: null };
    render(<OracleStatus pairIndex={0} />);
    expect(screen.getByTestId('oracle-quorum')).toHaveTextContent('—');
    expect(screen.queryByLabelText(/signatures required/)).not.toBeInTheDocument();
  });

  it('lists the healthy venues and the age of the last report', () => {
    render(<OracleStatus pairIndex={0} />);
    expect(screen.getByTestId('oracle-venues')).toHaveTextContent('BYB · OKX · BIN');
    expect(screen.getByTestId('oracle-age')).toHaveTextContent('2s ago');
    expect(screen.getByTestId('oracle-age')).not.toHaveClass('neg');
  });

  it('marks the report stale once it is older than the upkeep will accept', () => {
    price = { ...price, updatedAt: NOW_S - 11 };
    render(<OracleStatus pairIndex={0} />);
    expect(screen.getByTestId('oracle-age')).toHaveTextContent('11s ago');
    expect(screen.getByTestId('oracle-age')).toHaveClass('neg');
  });

  it('marks the venue list when the feed is degraded', () => {
    price = { ...price, healthyVenues: ['okx'], degraded: true };
    render(<OracleStatus pairIndex={0} />);
    expect(screen.getByTestId('oracle-venues')).toHaveTextContent('OKX');
    expect(screen.getByTestId('oracle-venues')).toHaveClass('neg');
  });

  it('renders dashes with no price at all', () => {
    price = undefined;
    render(<OracleStatus pairIndex={null} />);
    expect(screen.getByTestId('oracle-venues')).toHaveTextContent('—');
    expect(screen.getByTestId('oracle-age')).toHaveTextContent('—');
  });
});
