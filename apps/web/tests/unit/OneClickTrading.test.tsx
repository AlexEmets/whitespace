import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wallet = vi.hoisted(() => ({ isConnected: true }));
const sk = vi.hoisted(() => ({
  active: false,
  enabling: false,
  disabling: false,
  funding: false,
  error: null as string | null,
  gasWei: null as bigint | null,
  lowGas: false,
  sessionAddress: null as string | null,
  enable: vi.fn(),
  disable: vi.fn(),
  fundGas: vi.fn(),
}));

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: wallet.isConnected }) }));
vi.mock('@/hooks/useSessionKey', () => ({ useSessionKey: () => sk }));

import { OneClickTrading } from '@/components/OneClickTrading';

beforeEach(() => {
  wallet.isConnected = true;
  Object.assign(sk, {
    active: false,
    enabling: false,
    disabling: false,
    funding: false,
    error: null,
    gasWei: null,
    lowGas: false,
    sessionAddress: null,
  });
  sk.enable.mockClear();
  sk.disable.mockClear();
  sk.fundGas.mockClear();
});

describe('<OneClickTrading>', () => {
  it('offers nothing until a wallet is connected', () => {
    wallet.isConnected = false;
    render(<OneClickTrading />);
    expect(screen.queryByTestId('one-click-trading')).not.toBeInTheDocument();
  });

  it('offers to enable when off, and enables on click', () => {
    render(<OneClickTrading />);
    expect(screen.getByTestId('one-click-status')).toHaveTextContent('Off');
    expect(screen.getByText(/without a wallet pop-up/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('one-click-enable'));
    expect(sk.enable).toHaveBeenCalledTimes(1);
  });

  it('shows the enabling state and disables the button while it runs', () => {
    sk.enabling = true;
    render(<OneClickTrading />);
    expect(screen.getByTestId('one-click-enable')).toBeDisabled();
    expect(screen.getByTestId('one-click-enable')).toHaveTextContent(/Enabling/);
  });

  it('surfaces an error from enabling', () => {
    sk.error = 'Transaction reverted on chain.';
    render(<OneClickTrading />);
    expect(screen.getByTestId('one-click-error')).toHaveTextContent(/reverted/);
  });

  it('shows On with the session key gas and manage actions when active', () => {
    sk.active = true;
    sk.gasWei = 50_000_000_000_000_000n; // 0.05 WBT
    sk.sessionAddress = '0xabcdef0000000000000000000000000000001234';
    render(<OneClickTrading />);
    expect(screen.getByTestId('one-click-status')).toHaveTextContent('On');
    expect(screen.getByTestId('one-click-gas')).toHaveTextContent('0.0500 WBT');
    expect(screen.getByText('0xabcd…1234')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('one-click-fund'));
    expect(sk.fundGas).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('one-click-disable'));
    expect(sk.disable).toHaveBeenCalledTimes(1);
  });

  it('warns and flags the gas as low when the session key is nearly empty', () => {
    sk.active = true;
    sk.gasWei = 1_000_000_000_000_000n; // 0.001 WBT
    sk.lowGas = true;
    render(<OneClickTrading />);
    expect(screen.getByTestId('one-click-gas')).toHaveTextContent('low');
    expect(screen.getByText(/top up so your next trade/i)).toBeInTheDocument();
  });
});
