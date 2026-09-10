import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Money } from '@/components/Money';

describe('<Money>', () => {
  // The two proofTrade numbers from deployments/1874-operational.json, in the human
  // decimal form the read API emits them in (services/api's format.ts always prints
  // exactly `decimals` fraction digits) — that is what actually reaches this component.
  it('renders the real open price as the read API sends it (65,001.00)', () => {
    render(<Money value="65001.000000000000000000" decimals={18} />);
    expect(screen.getByText('65,001.00')).toBeInTheDocument();
  });

  it('renders the real collateral as the read API sends it (999.00)', () => {
    render(<Money value="999.000000" decimals={6} />);
    expect(screen.getByText('999.00')).toBeInTheDocument();
  });

  it('accepts a suffix', () => {
    render(<Money value="999.000000" decimals={6} suffix="USDW" />);
    expect(screen.getByText('999.00 USDW')).toBeInTheDocument();
  });

  it('accepts a bigint value directly', () => {
    render(<Money value={999000000n} decimals={6} />);
    expect(screen.getByText('999.00')).toBeInTheDocument();
  });

  it('throws (does not silently render a wrong figure) when given a number prop', () => {
    // @ts-expect-error deliberately violating the prop type to prove the runtime guard
    // in src/lib/money.ts fires even if a caller bypasses TypeScript.
    expect(() => render(<Money value={999.5} decimals={6} />)).toThrow();
  });
});
