import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareTradeButton } from '@/components/share/ShareTradeButton';
import type { ShareCard } from '@/lib/shareCard';

const ADDRESS = '0x00000000000000000000000000000000000000AA';
const CARD: ShareCard = {
  status: 'closed',
  market: 'BTC-PERP',
  side: 'long',
  leverage: '10×',
  entry: '80,000.00',
  exit: '81,000.00',
  exitLabel: 'Exit',
  pnl: '+12.50 USDW',
  roe: '+12.50%',
  positive: true,
  reason: null,
  partial: null,
  date: '28 Sep 2026',
};

function renderButton() {
  render(<ShareTradeButton address={ADDRESS} shareRef={{ kind: 'closed', closeOrderId: '41' }} card={CARD} testId="share-41" />);
  fireEvent.click(screen.getByTestId('share-41'));
}

beforeEach(() => {
  document.documentElement.setAttribute('data-theme', 'solar');
});

afterEach(() => {
  vi.restoreAllMocks();
  // navigator.share is not in jsdom; tests that add it remove it again.
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { canShare?: unknown }).canShare;
});

describe('<ShareTradeButton>', () => {
  /** At the default 23rem the 1200×630 card previewed at about 300px wide — too small to
   *  read the figures on it before posting them. */
  it('opens as a large sheet, so the card preview can be read', () => {
    renderButton();
    expect(screen.getByTestId('share-dialog')).toHaveAttribute('data-size', 'large');
  });

  it('previews the card image the link will show, in the current theme', () => {
    renderButton();
    expect(screen.getByTestId('share-preview')).toHaveAttribute(
      'src',
      '/share/0x00000000000000000000000000000000000000aa/c41/card.png',
    );
  });

  it('uses the Lunar card when the page is in the Lunar theme', () => {
    document.documentElement.setAttribute('data-theme', 'lunar');
    renderButton();
    expect(screen.getByTestId('share-preview')).toHaveAttribute(
      'src',
      '/share/0x00000000000000000000000000000000000000aa/c41/card.png?t=lunar',
    );
  });

  it('posts to X with the text and the absolute share link', () => {
    renderButton();
    const href = screen.getByTestId('share-x').getAttribute('href')!;
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe('https://x.com/intent/tweet');
    expect(url.searchParams.get('text')).toBe('Closed a 10× long on BTC-PERP at +12.50% on Whitespace testnet');
    expect(url.searchParams.get('url')).toBe(`${window.location.origin}/share/0x00000000000000000000000000000000000000aa/c41`);
    expect(screen.getByTestId('share-x')).toHaveAttribute('target', '_blank');
  });

  it('copies the share link', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderButton();
    fireEvent.click(screen.getByTestId('share-copy-link'));
    await waitFor(() => expect(screen.getByTestId('share-copy-link')).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/0x00000000000000000000000000000000000000aa/c41`);
  });

  it('downloads the card image it previews', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['png'], { type: 'image/png' })));
    const createUrl = vi.fn(() => 'blob:card');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderButton();
    fireEvent.click(screen.getByTestId('share-download'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledWith('/share/0x00000000000000000000000000000000000000aa/c41/card.png');
    expect(createUrl).toHaveBeenCalled();
  });

  it('offers the system share sheet only where the browser can share files', () => {
    renderButton();
    expect(screen.queryByTestId('share-native')).not.toBeInTheDocument();
  });

  it('hands the image to the system share sheet on a phone', async () => {
    const share = vi.fn(async (_data: { files: File[]; url: string; text: string }) => undefined);
    Object.assign(navigator, { share, canShare: () => true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['png'], { type: 'image/png' })));
    renderButton();
    fireEvent.click(screen.getByTestId('share-native'));
    await waitFor(() => expect(share).toHaveBeenCalled());
    const payload = share.mock.calls[0]![0] as { files: File[]; url: string };
    expect(payload.files[0]!.name).toBe('whitespace-btc-perp-c41.png');
    expect(payload.url).toBe(`${window.location.origin}/share/0x00000000000000000000000000000000000000aa/c41`);
  });
});
