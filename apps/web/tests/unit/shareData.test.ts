import { describe, expect, it, vi } from 'vitest';
import { loadShareCard, type FetchJson } from '@/lib/shareData';

const ADDRESS = '0x00000000000000000000000000000000000000aa';
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0) / 1000;

const MARKETS = [
  { pairIndex: 0, from: 'BTC', to: 'USD' },
  { pairIndex: 1, from: 'ETH', to: 'USD' },
];

const HISTORY = [
  {
    pairIndex: 0,
    index: 0,
    buy: true,
    collateral: '100.000000',
    leverage: '10.00',
    openPrice: '80000.000000000000000000',
    closePrice: '81000.000000000000000000',
    tp: '0.000000000000000000',
    sl: '0.000000000000000000',
    tradeId: '7',
    openedAt: T0 - 3600,
    closedAt: T0,
    closeReason: 'tp',
    realizedPnl: '12.500000',
    closeOrderId: '41',
    isPartial: false,
    percentageClosed: '100.00',
  },
];

const OPEN = [
  {
    pairIndex: 1,
    index: 0,
    buy: false,
    collateral: '200.000000',
    leverage: '5.00',
    openPrice: '2000.000000000000000000',
    tp: '0.000000000000000000',
    sl: '0.000000000000000000',
    openedAt: T0 - 60,
    tradeId: '9',
  },
];

function fakeApi(overrides: Record<string, unknown> = {}): FetchJson {
  const routes: Record<string, unknown> = {
    '/markets': MARKETS,
    [`/positions/${ADDRESS}/history`]: HISTORY,
    [`/positions/${ADDRESS}`]: OPEN,
    '/price/1': { mark: '1800.000000000000000000' },
    ...overrides,
  };
  return vi.fn(async (path: string) => {
    if (!(path in routes)) throw new Error(`404 ${path}`);
    return routes[path];
  });
}

describe('loadShareCard', () => {
  it('finds a close by its close-order id and names its market', async () => {
    const result = await loadShareCard({ address: ADDRESS, id: 'c41' }, fakeApi(), T0);
    expect(result?.card.market).toBe('BTC-PERP');
    expect(result?.card.roe).toBe('+12.50%');
    expect(result?.card.reason).toBe('Take profit');
    expect(result?.theme).toBe('solar');
  });

  it('marks an open position to the live price', async () => {
    // Short 5x on 200 USDW from 2000, mark 1800: +10% on price = +100 USDW = +50%.
    const result = await loadShareCard({ address: ADDRESS, id: 'o9' }, fakeApi(), T0);
    expect(result?.card.status).toBe('open');
    expect(result?.card.side).toBe('short');
    expect(result?.card.exit).toBe('1,800.00');
    expect(result?.card.roe).toBe('+50.00%');
  });

  it('carries the Lunar theme from the link, and ignores anything else', async () => {
    expect((await loadShareCard({ address: ADDRESS, id: 'c41', theme: 'lunar' }, fakeApi(), T0))?.theme).toBe('lunar');
    expect((await loadShareCard({ address: ADDRESS, id: 'c41', theme: 'neon' }, fakeApi(), T0))?.theme).toBe('solar');
  });

  it('looks up the lower-cased address, however the link spelled it', async () => {
    const api = fakeApi();
    await loadShareCard({ address: ADDRESS.toUpperCase().replace('0X', '0x'), id: 'c41' }, api, T0);
    expect(api).toHaveBeenCalledWith(`/positions/${ADDRESS}/history`);
  });

  it('is null for a malformed address or id, without calling the API', async () => {
    const api = fakeApi();
    expect(await loadShareCard({ address: '0x123', id: 'c41' }, api, T0)).toBeNull();
    expect(await loadShareCard({ address: ADDRESS, id: 'c41/../x' }, api, T0)).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it('is null for a trade this address does not have', async () => {
    expect(await loadShareCard({ address: ADDRESS, id: 'c999' }, fakeApi(), T0)).toBeNull();
    expect(await loadShareCard({ address: ADDRESS, id: 'o999' }, fakeApi(), T0)).toBeNull();
  });

  it('is null when the API fails, rather than throwing into the page', async () => {
    const failing: FetchJson = vi.fn(async () => {
      throw new Error('502');
    });
    expect(await loadShareCard({ address: ADDRESS, id: 'c41' }, failing, T0)).toBeNull();
  });

  it('is null for an open position whose market has no price yet', async () => {
    expect(await loadShareCard({ address: ADDRESS, id: 'o9' }, fakeApi({ '/price/1': { mark: null } }), T0)).toBeNull();
  });
});
