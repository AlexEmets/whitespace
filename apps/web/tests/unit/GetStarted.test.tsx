import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseEther } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetStarted } from '@/components/GetStarted';
import { __resetTermsSession, acceptTerms } from '@/lib/legal';
import { hasSeenGetStarted, markGetStartedSeen } from '@/lib/testFunds';

/**
 * The first-connect setup dialog. The chain and the API are faked at the hook seams —
 * balances through useErc20/useWbtBalance, the WBT claim through the api client — while
 * the claim hooks (useWbtFaucet, useFaucet) and the Modal shell are the real ones, so the
 * buttons are wired exactly as they ship.
 */

const ADDRESS_A = '0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B';
const ADDRESS_B = '0x2222222222222222222222222222222222222222';

let address: string | undefined = ADDRESS_A;
let wbtWei: bigint | null = 0n;
let usdw = 0n;
let usdwLoaded = true;

const requestWbtMock = vi.fn();
const claimFaucetMock = vi.fn(async () => '0x01' as `0x${string}`);
const refetchBalanceMock = vi.fn(async () => {});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address, isConnected: Boolean(address) }),
}));

vi.mock('@/hooks/useWbtBalance', () => ({
  useWbtBalance: () => ({ wei: wbtWei }),
}));

vi.mock('@/hooks/useErc20', () => ({
  useErc20: (spender?: string) => ({
    balance: usdw,
    balanceLoaded: usdwLoaded,
    // Already allowed, so a claim does not go on to ask for the trading allowance.
    allowance: 10n ** 30n,
    hasSpender: Boolean(spender),
    refetchBalance: refetchBalanceMock,
    refetchAllowance: vi.fn(async () => {}),
    approve: vi.fn(async () => '0x02'),
    claimFaucet: claimFaucetMock,
    isWritePending: false,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { requestWbt: (...args: unknown[]) => requestWbtMock(...args) },
}));

// jsdom cannot navigate; the stand-in keeps the click and its handler.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetTermsSession();
  acceptTerms(); // the Terms come first (TermsGate); these tests start past them
  address = ADDRESS_A;
  wbtWei = 0n;
  usdw = 0n;
  usdwLoaded = true;
});

describe('<GetStarted> — when it opens', () => {
  it('renders nothing with no wallet connected', () => {
    address = undefined;
    render(<GetStarted />);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
  });

  it('opens on the first connect of a wallet with no gas and no margin, and remembers it', () => {
    render(<GetStarted />);
    expect(screen.getByTestId('get-started')).toBeInTheDocument();
    expect(hasSeenGetStarted(ADDRESS_A)).toBe(true);
  });

  it('opens for a wallet that has gas but no USDW, with the gas step already done', () => {
    wbtWei = parseEther('0.3');
    render(<GetStarted />);
    expect(screen.getByTestId('get-started-gas')).toHaveAttribute('data-done', 'true');
    expect(screen.queryByTestId('get-started-claim-wbt')).not.toBeInTheDocument();
    expect(screen.getByTestId('get-started-claim-usdw')).toBeEnabled();
  });

  it('stays shut for a wallet that already has gas and margin', () => {
    wbtWei = parseEther('0.3');
    usdw = 1_000_000_000n;
    render(<GetStarted />);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
    expect(hasSeenGetStarted(ADDRESS_A)).toBe(false);
  });

  /** An unread balance is a placeholder 0 — opening on it would greet funded wallets too. */
  it('waits until both balances are read before deciding', () => {
    wbtWei = null;
    usdwLoaded = false;
    const { rerender } = render(<GetStarted />);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();

    wbtWei = 0n;
    rerender(<GetStarted />);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();

    usdwLoaded = true;
    rerender(<GetStarted />);
    expect(screen.getByTestId('get-started')).toBeInTheDocument();
  });

  /** Two dialogs on one connect would be one too many: the Terms are asked for first. */
  it('waits until the Terms have been agreed to', () => {
    localStorage.clear();
    __resetTermsSession();
    render(<GetStarted />);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
    expect(hasSeenGetStarted(ADDRESS_A)).toBe(false);

    act(() => acceptTerms());
    expect(screen.getByTestId('get-started')).toBeInTheDocument();
  });

  it('does not ask again a wallet this browser has already offered setup to', () => {
    markGetStartedSeen(ADDRESS_A);
    render(<GetStarted />);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
  });

  it('stays closed through the next balance poll once dismissed', () => {
    const { rerender } = render(<GetStarted />);
    fireEvent.click(screen.getByTestId('get-started-close'));
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();

    wbtWei = 1n; // the poll brings a new value, the wallet still needs funding
    rerender(<GetStarted />);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
  });

  /** Where storage is blocked, the in-memory guard is what keeps it to once. */
  it('opens only once per page session even when storage is unavailable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      const { rerender } = render(<GetStarted />);
      fireEvent.click(screen.getByTestId('get-started-close'));
      wbtWei = 1n;
      rerender(<GetStarted />);
      expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('greets the next wallet on its own first connect', () => {
    markGetStartedSeen(ADDRESS_A);
    const { rerender } = render(<GetStarted />);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();

    address = ADDRESS_B;
    rerender(<GetStarted />);
    expect(screen.getByTestId('get-started')).toBeInTheDocument();
  });

  it('closes when the wallet that opened it disconnects', () => {
    const { rerender } = render(<GetStarted />);
    address = undefined;
    rerender(<GetStarted />);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
  });
});

describe('<GetStarted> — the gas step', () => {
  it('shows the wallet’s WBT balance', () => {
    wbtWei = parseEther('0.004');
    render(<GetStarted />);
    expect(screen.getByTestId('get-started-wbt-balance')).toHaveTextContent('0.0040 WBT');
  });

  it('claims WBT for the connected address and links the funding transaction', async () => {
    requestWbtMock.mockResolvedValueOnce({ ok: true, txHash: '0xabc123' });
    render(<GetStarted />);

    fireEvent.click(screen.getByTestId('get-started-claim-wbt'));

    await waitFor(() => expect(requestWbtMock).toHaveBeenCalledWith(ADDRESS_A));
    const success = await screen.findByTestId('get-started-wbt-success');
    expect(success.querySelector('a')).toHaveAttribute('href', 'https://explorer.testnet.whitechain.io/tx/0xabc123');
  });

  it('shows a faucet decline as the server worded it, with the wait until the next claim', async () => {
    requestWbtMock.mockResolvedValueOnce({
      ok: false,
      error: 'This wallet or network has already claimed WBT. Try again later.',
      retryAfterSeconds: 3600,
    });
    render(<GetStarted />);

    fireEvent.click(screen.getByTestId('get-started-claim-wbt'));

    const error = await screen.findByTestId('get-started-wbt-error');
    expect(error).toHaveTextContent('already claimed WBT');
    expect(error).toHaveTextContent('Try again in 1h.');
  });

  it('marks the step done once enough gas has arrived', () => {
    const { rerender } = render(<GetStarted />);
    expect(screen.getByTestId('get-started-gas')).toHaveAttribute('data-done', 'false');

    wbtWei = parseEther('0.3');
    rerender(<GetStarted />);
    expect(screen.getByTestId('get-started-gas')).toHaveAttribute('data-done', 'true');
    expect(screen.queryByTestId('get-started-claim-wbt')).not.toBeInTheDocument();
  });
});

describe('<GetStarted> — the margin step', () => {
  it('holds the USDW claim while the wallet has no gas to sign it, and says why', () => {
    render(<GetStarted />);
    expect(screen.getByTestId('get-started-claim-usdw')).toBeDisabled();
    expect(screen.getByTestId('get-started-usdw-needs-gas')).toBeInTheDocument();
  });

  it('lets any gas at all unlock the claim, even below the setup threshold', async () => {
    wbtWei = 1n;
    render(<GetStarted />);
    const claim = screen.getByTestId('get-started-claim-usdw');
    expect(claim).toBeEnabled();
    expect(screen.queryByTestId('get-started-usdw-needs-gas')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(claim);
    });
    expect(claimFaucetMock).toHaveBeenCalledTimes(1);
    expect(refetchBalanceMock).toHaveBeenCalled();
  });

  it('shows the claim’s failure in the step', async () => {
    wbtWei = parseEther('0.3');
    claimFaucetMock.mockRejectedValueOnce(new Error('boom'));
    render(<GetStarted />);

    fireEvent.click(screen.getByTestId('get-started-claim-usdw'));

    expect(await screen.findByTestId('get-started-usdw-error')).toBeInTheDocument();
  });

  it('marks the step done once USDW is in the wallet', () => {
    wbtWei = parseEther('0.3');
    const { rerender } = render(<GetStarted />);
    usdw = 1_000_000_000n;
    rerender(<GetStarted />);
    expect(screen.getByTestId('get-started-usdw')).toHaveAttribute('data-done', 'true');
    expect(screen.getByTestId('get-started-usdw-balance')).toHaveTextContent('1,000.00 USDW');
    expect(screen.queryByTestId('get-started-claim-usdw')).not.toBeInTheDocument();
  });
});

describe('<GetStarted> — focus', () => {
  it('puts focus on the WBT claim, the first thing a new wallet needs', () => {
    render(<GetStarted />);
    expect(screen.getByTestId('get-started-claim-wbt')).toHaveFocus();
  });

  it('puts focus on the USDW claim when the wallet already has gas', () => {
    wbtWei = parseEther('0.3');
    render(<GetStarted />);
    expect(screen.getByTestId('get-started-claim-usdw')).toHaveFocus();
  });
});

describe('<GetStarted> — leaving', () => {
  it('offers a quiet way to the terminal while the wallet still cannot trade', () => {
    render(<GetStarted />);
    const trade = screen.getByTestId('get-started-trade');
    expect(trade).toHaveAttribute('data-ready', 'false');
    expect(trade).toHaveTextContent('Go to the terminal');
  });

  it('turns it into Start trading once both steps are done', () => {
    const { rerender } = render(<GetStarted />);
    wbtWei = parseEther('0.3');
    usdw = 1_000_000_000n;
    rerender(<GetStarted />);
    const trade = screen.getByTestId('get-started-trade');
    expect(trade).toHaveAttribute('data-ready', 'true');
    expect(trade).toHaveTextContent('Start trading');
  });

  it('sends the trader to the terminal and closes', () => {
    render(<GetStarted />);
    const trade = screen.getByTestId('get-started-trade');
    expect(trade).toHaveAttribute('href', '/trade');
    fireEvent.click(trade);
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
  });

  it('points at the faucet page for later claims', () => {
    render(<GetStarted />);
    expect(screen.getByTestId('get-started-faucet')).toHaveAttribute('href', '/faucet');
  });
});
