import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket, seedOpenPosition, seedClosedPosition, seedPartialClose, TRADER, OTHER_TRADER, TX_B } from './seed.js';
import { getPool } from '../src/db.js';
import { POSITION_HISTORY_DEFAULT_LIMIT, POSITION_HISTORY_MAX_LIMIT } from '../src/routes/positions.js';

describe('GET /positions/:address', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedMarket();
  });

  it('returns an empty array for an address with no positions', async () => {
    const res = await fetch(`${server.baseUrl}/positions/${OTHER_TRADER}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns the open position with the exact shape and real proof-trade values', async () => {
    await seedOpenPosition();
    const res = await fetch(`${server.baseUrl}/positions/${TRADER}`);
    const body = await res.json();
    expect(body).toEqual([
      {
        pairIndex: 0,
        index: 0,
        buy: true,
        collateral: '999.000000',
        leverage: '10.00',
        openPrice: '65001.000000000000000000',
        tp: '0.000000000000000000',
        sl: '0.000000000000000000',
        openedAt: 1788881876,
        tradeId: '2',
      },
    ]);
  });

  it('is case-insensitive on the trader address (checksum vs lowercase)', async () => {
    await seedOpenPosition();
    const checksummed = '0x2b8ba090DEdF879f8045c0dDA5a78762cED90D19';
    const res = await fetch(`${server.baseUrl}/positions/${checksummed}`);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it('does not leak another trader\'s position (filter proven both ways)', async () => {
    await seedOpenPosition();
    const mine = await (await fetch(`${server.baseUrl}/positions/${TRADER}`)).json();
    const theirs = await (await fetch(`${server.baseUrl}/positions/${OTHER_TRADER}`)).json();
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});

describe('GET /positions/:address/history', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedMarket();
  });

  it('returns an empty array when nothing has closed', async () => {
    const res = await fetch(`${server.baseUrl}/positions/${TRADER}/history`);
    expect(await res.json()).toEqual([]);
  });

  it('returns the closed proof trade with realised pnl computed as exact bigint subtraction', async () => {
    await seedClosedPosition();
    const res = await fetch(`${server.baseUrl}/positions/${TRADER}/history`);
    const body = await res.json();
    expect(body).toHaveLength(1);
    const row = body[0];
    expect(row.tradeId).toBe('2');
    expect(row.closePrice).toBe('64999.000000000000000000');
    expect(row.closeReason).toBe('close');
    expect(row.usdcSentToTrader).toBe('998.692628');
    expect(row.collateral).toBe('999.000000');
    // realizedPnl = usdcSentToTrader - collateral = 998692628 - 999000000 = -307372 (PRECISION_6)
    expect(row.realizedPnl).toBe('-0.307372');
  });

  it('formats percentProfit as a 6-decimal percent, the unit the contract uses', async () => {
    // WhitespacePairInfos.getTradeValuePure: value = collateral + collateral * percentProfit / 1e6 / 100,
    // so percentProfit is a percent with 6 decimals. The proof trade's raw -30768 is -0.030768 %:
    // 999 USDW * -0.030768 % = -0.307372 USDW, exactly its realised PnL above. Formatted at 18 dp
    // it read '-0.000000000000030768', 1e12 too small.
    await seedClosedPosition();
    const [row] = await (await fetch(`${server.baseUrl}/positions/${TRADER}/history`)).json();
    expect(row.percentProfit).toBe('-0.030768');
    expect(Number(row.percentProfit) / Number('-0.000000000000030768')).toBeCloseTo(1e12, -3);
  });

  it('includes partial closes, newest first, each with its own realised PnL', async () => {
    await seedClosedPosition(); // closed_at 1788881880
    await seedPartialClose(); // closed_at 1788881878
    const body = await (await fetch(`${server.baseUrl}/positions/${TRADER}/history`)).json();
    expect(body.map((r: { closeOrderId: string; isPartial: boolean }) => [r.closeOrderId, r.isPartial])).toEqual([
      ['3', false],
      ['5', true],
    ]);
    expect(body[0]).toMatchObject({ percentageClosed: '100.00', realizedPnl: '-0.307372' });
    expect(body[1]).toEqual({
      pairIndex: 0,
      index: 0,
      buy: true,
      collateral: '249.750000', // the part closed
      leverage: '10.00',
      openPrice: '65001.000000000000000000',
      closePrice: '65700.000000000000000000',
      tp: null,
      sl: null,
      tradeId: '2',
      openedAt: 1788881876,
      closedAt: 1788881878,
      closeReason: 'close',
      percentProfit: '41.041041',
      usdcSentToTrader: '260.000000',
      realizedPnl: '10.250000',
      closeOrderId: '5',
      closeTxHash: TX_B,
      percentageClosed: '25.00',
      isPartial: true,
    });
  });

  it('history is scoped per-trader (filter proven both ways)', async () => {
    await seedClosedPosition();
    const mine = await (await fetch(`${server.baseUrl}/positions/${TRADER}/history`)).json();
    const theirs = await (await fetch(`${server.baseUrl}/positions/${OTHER_TRADER}/history`)).json();
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});

describe('GET /positions/:address/history is bounded', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
    await truncateAll();
    await seedMarket();
    // DEFAULT + 1 full closes at closed_at 1..501, and 3 partial closes interleaved at the top.
    await getPool().query(
      `INSERT INTO closed_position (trade_id, trader, pair_index, index, buy, collateral, leverage, open_price, close_price, tp, sl,
         close_reason, percent_profit, usdc_sent_to_trader, percentage_closed, open_order_id, close_order_id, opened_at, closed_at, close_tx_hash)
       SELECT g, $1, 0, 0, true, 1, 100, 1, 1, 0, 0, 'close', 0, 1, 10000, g, 100000 + g, g, g, '0x01'
         FROM generate_series(1, $2::int) g`,
      [TRADER, POSITION_HISTORY_DEFAULT_LIMIT + 1],
    );
    for (const closedAt of [10_000, 10_002, 10_004]) await seedPartialClose({ orderId: closedAt, closedAt });
  });
  afterAll(async () => {
    await server.close();
  });

  const get = async (q: string) => {
    const res = await fetch(`${server.baseUrl}/positions/${TRADER}/history${q}`);
    return { status: res.status, body: await res.json() };
  };

  it(`defaults to the newest ${POSITION_HISTORY_DEFAULT_LIMIT}`, async () => {
    const { body } = await get('');
    expect(body).toHaveLength(POSITION_HISTORY_DEFAULT_LIMIT);
    expect(body[0].closedAt).toBe(10_004);
    // 504 rows exist; the 4 oldest full closes (closed_at 1..4) are the ones dropped.
    expect(body[body.length - 1].closedAt).toBe(5);
  });

  it('honours ?limit across both sources, newest first', async () => {
    const { body } = await get('?limit=4');
    expect(body.map((r: { closedAt: number; isPartial: boolean }) => [r.closedAt, r.isPartial])).toEqual([
      [10_004, true],
      [10_002, true],
      [10_000, true],
      [POSITION_HISTORY_DEFAULT_LIMIT + 1, false],
    ]);
  });

  it(`accepts ?limit=${POSITION_HISTORY_MAX_LIMIT} (boundary) and returns everything there is`, async () => {
    const { status, body } = await get(`?limit=${POSITION_HISTORY_MAX_LIMIT}`);
    expect(status).toBe(200);
    expect(body).toHaveLength(POSITION_HISTORY_DEFAULT_LIMIT + 4);
  });

  it.each(['0', String(POSITION_HISTORY_MAX_LIMIT + 1), 'abc', '-5', '1.5'])('rejects ?limit=%s with 400', async (raw) => {
    expect((await get(`?limit=${raw}`)).status).toBe(400);
  });
});

describe('address validation on the pre-existing wallet routes', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  const BAD = ['nope', '0x1234', `${TRADER}00`, '0xZZ8ba090dedf879f8045c0dda5a78762ced90d19'];
  const ROUTES = ['/positions/%s', '/positions/%s/history', '/orders/%s'];

  for (const route of ROUTES) {
    it.each(BAD)(`${route} answers 400 for %s`, async (addr) => {
      const res = await fetch(`${server.baseUrl}${route.replace('%s', addr)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid address' });
    });

    it(`${route} still answers 200 for a well-formed address`, async () => {
      const res = await fetch(`${server.baseUrl}${route.replace('%s', OTHER_TRADER)}`);
      expect(res.status).toBe(200);
    });
  }
});
