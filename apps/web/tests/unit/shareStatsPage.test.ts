// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

// React's `cache` exists only in the react-server build Next renders pages with; under
// vitest the plain build has none. Per-request memoising is not what is tested here.
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), cache: <T>(fn: T) => fn }));

import { generateMetadata } from '@/app/share/[address]/stats/page';

const ADDRESS = '0x00000000000000000000000000000000000000aa';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function api(history: unknown[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    json(String(input).endsWith('/markets') ? [{ pairIndex: 0, from: 'BTC', to: 'USD' }] : history),
  );
}

const CLOSE = {
  pairIndex: 0,
  index: 0,
  buy: true,
  collateral: '100.000000',
  leverage: '10.00',
  openPrice: '80000.000000000000000000',
  closePrice: '81000.000000000000000000',
  tp: '0',
  sl: '0',
  tradeId: '7',
  openedAt: 1_790_000_000,
  closedAt: 1_790_003_600,
  closeReason: 'tp',
  realizedPnl: '12.500000',
  closeOrderId: '41',
  isPartial: false,
  percentageClosed: '100.00',
};

const meta = (t?: string) =>
  generateMetadata({ params: Promise.resolve({ address: ADDRESS }), searchParams: Promise.resolve(t ? { t } : {}) });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/share/:address/stats metadata', () => {
  it('makes the stats card the large preview on X and Telegram, titled with the record', async () => {
    api([CLOSE]);
    const m = await meta();
    expect(m.twitter).toMatchObject({ card: 'summary_large_image' });
    expect(JSON.stringify(m.openGraph)).toContain(`/share/${ADDRESS}/stats/card.png`);
    expect(m.title).toBe('+12.50 USDW realised over 1 trade with a 100% win rate on Whitespace testnet — Whitespace');
  });

  it('previews the Lunar card for a Lunar link', async () => {
    api([CLOSE]);
    expect(JSON.stringify((await meta('lunar')).openGraph)).toContain(`/share/${ADDRESS}/stats/card.png?t=lunar`);
  });

  it('says there is nothing to show for a wallet with no closes', async () => {
    api([]);
    expect((await meta()).title).toBe('No trades yet — Whitespace');
  });
});
