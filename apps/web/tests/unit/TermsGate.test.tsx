import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TermsGate } from '@/components/TermsGate';
import { TERMS_VERSION, __resetTermsSession, acceptTerms, hasAcceptedTerms } from '@/lib/legal';

/**
 * The agreement asked for on a wallet's first connect. The real storage-backed record is
 * used (jsdom's localStorage); only wagmi is faked.
 */

let isConnected = true;
const disconnectMock = vi.fn();

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected }),
  useDisconnect: () => ({ disconnect: disconnectMock }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetTermsSession();
  isConnected = true;
});

describe('<TermsGate>', () => {
  it('asks nothing of a visitor with no wallet connected', () => {
    isConnected = false;
    render(<TermsGate />);
    expect(screen.queryByTestId('terms-gate')).not.toBeInTheDocument();
  });

  it('asks a connected wallet to agree before anything else', () => {
    render(<TermsGate />);
    expect(screen.getByTestId('terms-gate')).toBeInTheDocument();
  });

  it('links both documents and names the restricted jurisdictions', () => {
    render(<TermsGate />);
    const gate = screen.getByTestId('terms-gate');
    expect(gate.querySelector('a[href="/terms"]')).not.toBeNull();
    expect(gate.querySelector('a[href="/privacy"]')).not.toBeNull();
    expect(gate).toHaveTextContent(/United States, sanctioned countries/);
    expect(gate).toHaveTextContent(/points are not a promise of any token or airdrop/);
  });

  it('starts with the box unticked and focused, and holds Agree until it is ticked', () => {
    render(<TermsGate />);
    const box = screen.getByTestId('terms-gate-checkbox');
    expect(box).not.toBeChecked();
    expect(box).toHaveFocus();
    expect(screen.getByTestId('terms-gate-agree')).toBeDisabled();

    fireEvent.click(box);
    expect(screen.getByTestId('terms-gate-agree')).toBeEnabled();
  });

  it('records the agreement and gets out of the way', () => {
    render(<TermsGate />);
    fireEvent.click(screen.getByTestId('terms-gate-checkbox'));
    fireEvent.click(screen.getByTestId('terms-gate-agree'));

    expect(hasAcceptedTerms()).toBe(true);
    expect(screen.queryByTestId('terms-gate')).not.toBeInTheDocument();
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it('does not ask a browser that has already agreed to this version', () => {
    acceptTerms();
    render(<TermsGate />);
    expect(screen.queryByTestId('terms-gate')).not.toBeInTheDocument();
  });

  it('disconnects the wallet when the trader declines', () => {
    render(<TermsGate />);
    fireEvent.click(screen.getByTestId('terms-gate-decline'));
    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(hasAcceptedTerms()).toBe(false);
  });

  /** Closing is declining: there is no way past the gate other than agreeing. */
  it('treats closing the dialog any other way as declining', () => {
    render(<TermsGate />);
    fireEvent.click(screen.getByTestId('terms-gate-close'));
    expect(disconnectMock).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(disconnectMock).toHaveBeenCalledTimes(2);
    expect(hasAcceptedTerms()).toBe(false);
  });

  it('closes when an agreement is given in another tab', () => {
    render(<TermsGate />);
    act(() => {
      localStorage.setItem('whitespace:terms-accepted', TERMS_VERSION);
      window.dispatchEvent(new StorageEvent('storage', { key: 'whitespace:terms-accepted' }));
    });
    expect(screen.queryByTestId('terms-gate')).not.toBeInTheDocument();
  });
});
