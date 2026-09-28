import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketHeaderBar } from '@/components/terminal/MarketHeaderBar';
import type { MarketSummary } from '@/lib/types';

let fundingData: readonly [bigint, bigint, bigint, bigint] | undefined;
vi.mock('wagmi', () => ({ useReadContract: () => ({ data: fundingData }) }));
vi.mock('@/hooks/usePrice', () => ({
  usePrice: () => ({ data: { mark: '65001.000000000000000000', index: '65000.000000000000000000' } }),
}));
vi.mock('@/hooks/useMarket24h', () => ({
  useMarket24h: () => null,
  formatWindowLabel: () => '24h',
}));

const BTC: MarketSummary = {
  pairIndex: 0,
  from: 'BTC',
  to: 'USD',
  feedId: '0x00',
  maxLeverage: '100.00',
  maxOpenInterest: '1000000.000000',
  openInterest: { long: '1500.000000', short: '500.000000' },
};

beforeEach(() => {
  fundingData = undefined;
});

describe('<MarketHeaderBar>', () => {
  it('shows mark, index and total open interest', () => {
    render(<MarketHeaderBar market={BTC} />);
    expect(screen.getByTestId('mark-price')).toHaveTextContent('65,001.00');
    expect(screen.getByTestId('index-price')).toHaveTextContent('65,000.00');
    expect(screen.getByTestId('market-header')).toHaveTextContent('2,000.00');
  });

  it('shows a dash for funding until the rate is read', () => {
    render(<MarketHeaderBar market={BTC} />);
    expect(screen.getByTestId('funding-rate')).toHaveTextContent('—');
  });

  it('shows the live funding rate per hour, signed', () => {
    // 31,709,791,983 per block is the 100%/year cap → +0.0114% per hour
    fundingData = [0n, 0n, 31_709_791_983n, 0n];
    render(<MarketHeaderBar market={BTC} />);
    expect(screen.getByTestId('funding-rate')).toHaveTextContent('+0.0114%');
  });

  it('a negative rate (shorts pay longs) keeps its sign', () => {
    fundingData = [0n, 0n, -31_709_791_983n, 0n];
    render(<MarketHeaderBar market={BTC} />);
    expect(screen.getByTestId('funding-rate')).toHaveTextContent('-0.0114%');
  });
});
