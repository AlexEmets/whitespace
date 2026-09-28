import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WbtFaucetPanel } from '@/components/WbtFaucetPanel';

/**
 * The WBT faucet is not a wallet transaction — it is a POST to services/api that sends
 * native gas from a server wallet — so these tests mock the api client, not viem. What
 * matters is that a structured decline (cooldown, out-of-funds) is shown as the message
 * the server sent, that a cooldown adds a human retry hint, and that a dropped connection
 * is not misreported as one of those.
 */

const requestWbtMock = vi.fn();
let isConnected = true;
const ADDRESS = '0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B';

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: isConnected ? ADDRESS : undefined, isConnected }),
}));

vi.mock('@/lib/api', () => ({
  api: { requestWbt: (...args: unknown[]) => requestWbtMock(...args) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  isConnected = true;
});

describe('<WbtFaucetPanel>', () => {
  it('states how much gas it sends and how often, so the cooldown is not a surprise', () => {
    render(<WbtFaucetPanel />);
    expect(screen.getByTestId('wbt-faucet-amount')).toHaveTextContent('0.3 WBT');
    expect(screen.getByTestId('wbt-faucet-panel')).toHaveTextContent(/once per 24h, per wallet and ip/i);
  });

  it('offers no request with no wallet to send to', () => {
    isConnected = false;
    render(<WbtFaucetPanel />);
    expect(screen.queryByTestId('wbt-faucet-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('wbt-faucet-disconnected')).toBeInTheDocument();
  });

  it('sends to the connected address and links the funding transaction on success', async () => {
    requestWbtMock.mockResolvedValueOnce({ ok: true, txHash: '0xabc123', amountWei: '300000000000000000', from: '0xfee' });
    render(<WbtFaucetPanel />);

    fireEvent.click(screen.getByTestId('wbt-faucet-button'));

    await waitFor(() => expect(requestWbtMock).toHaveBeenCalledWith(ADDRESS));
    const success = await screen.findByTestId('wbt-faucet-success');
    expect(success).toBeInTheDocument();
    const link = screen.getByTestId('wbt-faucet-tx');
    expect(link).toHaveAttribute('href', 'https://explorer.testnet.whitechain.io/tx/0xabc123');
  });

  /**
   * The failure a repeat visitor hits: the API returns 429 with a message and the seconds
   * until they can claim again. The panel must show the cooldown as a cadence with a
   * concrete retry time, not as a broken faucet.
   */
  it('turns a cooldown decline into a message with a human retry time', async () => {
    requestWbtMock.mockResolvedValueOnce({
      ok: false,
      error: 'This wallet or network has already claimed WBT. Try again later.',
      retryAfterSeconds: 3600,
    });
    render(<WbtFaucetPanel />);

    fireEvent.click(screen.getByTestId('wbt-faucet-button'));

    const error = await screen.findByTestId('wbt-faucet-error');
    expect(error).toHaveTextContent(/already claimed/i);
    expect(error).toHaveTextContent(/try again in 1h/i);
    expect(screen.queryByTestId('wbt-faucet-success')).not.toBeInTheDocument();
  });

  it('shows the out-of-funds message with no retry hint when the wallet is dry', async () => {
    requestWbtMock.mockResolvedValueOnce({ ok: false, error: 'The WBT faucet is temporarily out of funds.' });
    render(<WbtFaucetPanel />);

    fireEvent.click(screen.getByTestId('wbt-faucet-button'));

    const error = await screen.findByTestId('wbt-faucet-error');
    expect(error).toHaveTextContent(/out of funds/i);
    expect(error).not.toHaveTextContent(/try again in/i);
  });

  /**
   * A dropped connection is not a cooldown and must not read as one — the hook catches the
   * rejection and reports a distinct "could not reach the faucet" message.
   */
  it('reports a network failure distinctly from a server decline', async () => {
    requestWbtMock.mockRejectedValueOnce(new Error('network down'));
    render(<WbtFaucetPanel />);

    fireEvent.click(screen.getByTestId('wbt-faucet-button'));

    const error = await screen.findByTestId('wbt-faucet-error');
    expect(error).toHaveTextContent(/could not reach the faucet/i);
  });

  it('shows progress while the request is in flight so a slow send is not mistaken for no click', async () => {
    let release: () => void = () => {};
    requestWbtMock.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ ok: true, txHash: '0xabc' }); }),
    );
    render(<WbtFaucetPanel />);

    fireEvent.click(screen.getByTestId('wbt-faucet-button'));
    await waitFor(() => expect(screen.getByTestId('wbt-faucet-button')).toBeDisabled());
    expect(screen.getByTestId('wbt-faucet-button')).toHaveTextContent(/sending/i);

    release();
    await waitFor(() => expect(screen.getByTestId('wbt-faucet-success')).toBeInTheDocument());
  });
});
