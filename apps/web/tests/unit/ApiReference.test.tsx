import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_CHANNELS, publicEndpoints } from '@whitespace/shared/api';
import { ApiReference, PUBLIC_API, PUBLIC_WS, RESPONSE_PREVIEW_LINES, previewJson } from '@/components/docs/ApiReference';
import { API_BASE_URL, SITE_URL } from '@/lib/config';

/**
 * /docs/api renders the catalogue services/api is tested against. What is pinned here is the
 * page's own behaviour: every public endpoint shown and the faucet not, the wallet the
 * examples use, and "Try it" showing exactly what the API sent back — including when it
 * refuses or cannot be reached.
 */

const account = vi.hoisted(() => ({ address: undefined as string | undefined }));
vi.mock('wagmi', () => ({ useAccount: () => ({ address: account.address }) }));

const WALLET = '0x2F783207089fBdf0167868E6e4a85c086293E865';

function respond(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

const card = (path: string) => screen.getByTestId(`endpoint-${path}`);
const tryButton = (path: string) => screen.getByTestId(`try-${path}`);

beforeEach(() => {
  account.address = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<ApiReference>', () => {
  it('documents every public endpoint, and not the faucet that spends real gas', () => {
    render(<ApiReference />);
    for (const e of publicEndpoints()) expect(card(e.path)).toBeInTheDocument();
    expect(screen.queryByTestId('endpoint-/faucet/wbt')).toBeNull();
    expect(screen.getAllByTestId(/^endpoint-/)).toHaveLength(publicEndpoints().length);
  });

  it('lists every WebSocket channel', () => {
    render(<ApiReference />);
    for (const c of WS_CHANNELS) expect(screen.getByTestId(`channel-${c.kind}`)).toHaveTextContent(c.pattern);
  });

  it('gives the public addresses to paste, derived from the site origin', () => {
    render(<ApiReference />);
    expect(PUBLIC_API).toBe(`${SITE_URL}/api`);
    expect(PUBLIC_WS).toBe(`${SITE_URL.replace(/^http/, 'ws')}/ws`);
    expect(PUBLIC_WS.startsWith('ws')).toBe(true);
    expect(screen.getByTestId('api-base')).toHaveTextContent(PUBLIC_API);
    expect(screen.getByTestId('ws-base')).toHaveTextContent(PUBLIC_WS);
  });

  it('spells out the ?limit= range an endpoint accepts', () => {
    render(<ApiReference />);
    expect(card('/positions/:address/history')).toHaveTextContent('How many to return, 1 to 1,000. Default 500.');
    expect(card('/markets')).not.toHaveTextContent('How many to return');
  });

  it('calls the API on "Try it" and shows the status and the response as it came', async () => {
    const spy = respond(200, [{ pairIndex: 0, from: 'BTC' }, { pairIndex: 1, from: 'ETH' }]);
    render(<ApiReference />);
    expect(screen.queryByTestId('response-/markets')).toBeNull();
    fireEvent.click(tryButton('/markets'));
    const out = await screen.findByTestId('response-/markets');
    expect(spy).toHaveBeenCalledWith(`${API_BASE_URL}/markets`);
    expect(out).toHaveTextContent('200');
    expect(out).toHaveTextContent('2 items');
    expect(out).toHaveTextContent('"from": "ETH"');
  });

  it('shows a refusal as the API sent it, status and error', async () => {
    respond(400, { error: 'invalid pairIndex' });
    render(<ApiReference />);
    fireEvent.click(tryButton('/price/:pairIndex'));
    const out = await screen.findByTestId('response-/price/:pairIndex');
    expect(out).toHaveTextContent('400');
    expect(out).toHaveTextContent('"error": "invalid pairIndex"');
  });

  it('says so when the API cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ApiReference />);
    fireEvent.click(tryButton('/health'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the API: Failed to fetch');
  });

  it('holds a wallet endpoint back until a wallet is entered, then asks for that wallet, lower-cased', async () => {
    const spy = respond(200, []);
    render(<ApiReference />);
    expect(tryButton('/pnl/:address')).toBeDisabled();
    expect(within(card('/pnl/:address')).getByText('Enter a wallet above to try this one.')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('api-wallet'), { target: { value: WALLET } });
    expect(tryButton('/pnl/:address')).toBeEnabled();
    fireEvent.click(tryButton('/pnl/:address'));
    await screen.findByTestId('response-/pnl/:address');
    expect(spy).toHaveBeenCalledWith(`${API_BASE_URL}/pnl/${WALLET.toLowerCase()}`);
  });

  it('flags a malformed wallet and keeps its endpoints disabled', () => {
    render(<ApiReference />);
    fireEvent.change(screen.getByTestId('api-wallet'), { target: { value: '0x1234' } });
    expect(screen.getByText('That is not a wallet address.')).toBeInTheDocument();
    expect(tryButton('/positions/:address')).toBeDisabled();
    expect(tryButton('/markets')).toBeEnabled();
  });

  it('fills in the connected wallet, but never over one the reader typed', () => {
    const { rerender } = render(<ApiReference />);
    expect(screen.getByTestId('api-wallet')).toHaveValue('');
    account.address = WALLET;
    rerender(<ApiReference />);
    expect(screen.getByTestId('api-wallet')).toHaveValue(WALLET);

    fireEvent.change(screen.getByTestId('api-wallet'), { target: { value: '0x00000000000000000000000000000000000000aa' } });
    account.address = '0x00000000000000000000000000000000000000bb';
    rerender(<ApiReference />);
    expect(screen.getByTestId('api-wallet')).toHaveValue('0x00000000000000000000000000000000000000aa');
  });
});

describe('previewJson', () => {
  it('keeps a short response whole and counts the items of a list', () => {
    expect(previewJson({ status: 'ok' })).toEqual({ text: '{\n  "status": "ok"\n}', items: null });
    expect(previewJson([1, 2, 3]).items).toBe(3);
  });

  it(`folds everything after line ${RESPONSE_PREVIEW_LINES} into a count`, () => {
    const long = Array.from({ length: 100 }, (_, i) => i);
    const lines = previewJson(long).text.split('\n');
    // 102 lines of JSON ("[", 100 values, "]"): the first 40, then a note for the other 62.
    expect(lines).toHaveLength(RESPONSE_PREVIEW_LINES + 1);
    expect(lines[RESPONSE_PREVIEW_LINES]).toBe('… 62 more lines');
    expect(previewJson(long).items).toBe(100);
  });
});
