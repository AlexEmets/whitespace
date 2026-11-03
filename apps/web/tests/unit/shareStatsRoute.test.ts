// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/share/[address]/stats/card.png/route';

afterEach(() => {
  vi.restoreAllMocks();
});

function call(address: string) {
  return GET(new Request(`http://localhost/share/${address}/stats/card.png`), {
    params: Promise.resolve({ address }),
  });
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('GET /share/:address/stats/card.png', () => {
  it('is a 404 for a malformed address, without asking the API anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await call('0x123');
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is a 404 for a wallet with nothing closed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      json(String(input).endsWith('/markets') ? [{ pairIndex: 0, from: 'BTC', to: 'USD' }] : []),
    );
    const res = await call('0x00000000000000000000000000000000000000aa');
    expect(res.status).toBe(404);
  });

  it('renders the card as a PNG for a wallet with closes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/markets')) return json([{ pairIndex: 0, from: 'BTC', to: 'USD' }]);
      return json([
        {
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
        },
      ]);
    });
    const res = await call('0x00000000000000000000000000000000000000aa');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});
