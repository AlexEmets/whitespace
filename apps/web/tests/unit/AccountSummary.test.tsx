import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSummary } from '@/components/terminal/AccountSummary';

let address: string | undefined = '0xabc';
let positions: { pairIndex: number; buy: boolean; collateral: string; leverage: string; openPrice: string }[] = [];
let prices: Record<number, { mark: string }> = {};

vi.mock('wagmi', () => ({ useAccount: () => ({ address }) }));
vi.mock('@/hooks/useErc20', () => ({ useErc20: () => ({ balance: 5_000_000_000n }) }));
vi.mock('@/hooks/usePositions', () => ({ usePositions: () => ({ positions }) }));
vi.mock('@/hooks/useMarkPrices', () => ({ useMarkPrices: () => ({ prices }) }));

beforeEach(() => {
  address = '0xabc';
  positions = [];
  prices = {};
});

describe('<AccountSummary>', () => {
  it('renders nothing without a wallet', () => {
    address = undefined;
    const { container } = render(<AccountSummary />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sums wallet, isolated margin and unrealised PnL at the marks', () => {
    positions = [
      { pairIndex: 0, buy: true, collateral: '1000.000000', leverage: '10.00', openPrice: '100' }, // +10% → +1,000
      { pairIndex: 1, buy: false, collateral: '500.000000', leverage: '2.00', openPrice: '50' }, // +10% → -100
    ];
    prices = { 0: { mark: '110' }, 1: { mark: '55' } };
    render(<AccountSummary />);
    expect(screen.getByTestId('account-wallet')).toHaveTextContent('5,000.00');
    expect(screen.getByTestId('account-margin')).toHaveTextContent('1,500.00');
    expect(screen.getByTestId('account-upnl')).toHaveTextContent('+900.00');
    expect(screen.getByTestId('account-portfolio')).toHaveTextContent('7,400.00 USDW');
  });

  it('leaves a market without a mark out of UPnL and flags the total', () => {
    positions = [{ pairIndex: 0, buy: true, collateral: '1000.000000', leverage: '10.00', openPrice: '100' }];
    render(<AccountSummary />);
    expect(screen.getByTestId('account-upnl')).toHaveTextContent('+0.00 USDW*');
    expect(screen.getByTestId('account-summary')).toHaveTextContent('left out');
  });
});
