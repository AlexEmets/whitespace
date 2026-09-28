// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/share/[address]/[id]/card.png/route';

afterEach(() => {
  vi.restoreAllMocks();
});

function call(address: string, id: string) {
  return GET(new Request(`http://localhost/share/${address}/${id}/card.png`), {
    params: Promise.resolve({ address, id }),
  });
}

describe('GET /share/:address/:id/card.png', () => {
  it('is a 404 for a malformed link, without asking the API anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await call('0x123', 'c41');
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is a 404 when the API has no such trade', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const body = url.endsWith('/markets') ? [{ pairIndex: 0, from: 'BTC', to: 'USD' }] : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await call('0x00000000000000000000000000000000000000aa', 'c41');
    expect(res.status).toBe(404);
  });
});
