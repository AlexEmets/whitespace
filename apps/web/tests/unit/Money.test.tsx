import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Money } from '@/components/Money';

describe('<Money>', () => {
  it('renders the real open price from deployments/1874-operational.json as 65,001.00', () => {
    render(<Money value="65001000000000000000000" decimals={18} />);
    expect(screen.getByText('65,001.00')).toBeInTheDocument();
  });

  it('renders the real collateral from deployments/1874-operational.json as 999.00', () => {
    render(<Money value="999000000" decimals={6} />);
    expect(screen.getByText('999.00')).toBeInTheDocument();
  });

  it('accepts a suffix', () => {
    render(<Money value="999000000" decimals={6} suffix="USDW" />);
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
