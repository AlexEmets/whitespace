import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket, seedOpenPosition, seedClosedPosition, TRADER, OTHER_TRADER } from './seed.js';

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
    // OstiumPairInfos.getTradeValuePure: value = collateral + collateral * percentProfit / 1e6 / 100,
    // so percentProfit is a percent with 6 decimals. The proof trade's raw -30768 is -0.030768 %:
    // 999 USDW * -0.030768 % = -0.307372 USDW, exactly its realised PnL above. Formatted at 18 dp
    // it read '-0.000000000000030768', 1e12 too small.
    await seedClosedPosition();
    const [row] = await (await fetch(`${server.baseUrl}/positions/${TRADER}/history`)).json();
    expect(row.percentProfit).toBe('-0.030768');
    expect(Number(row.percentProfit) / Number('-0.000000000000030768')).toBeCloseTo(1e12, -3);
  });

  it('history is scoped per-trader (filter proven both ways)', async () => {
    await seedClosedPosition();
    const mine = await (await fetch(`${server.baseUrl}/positions/${TRADER}/history`)).json();
    const theirs = await (await fetch(`${server.baseUrl}/positions/${OTHER_TRADER}/history`)).json();
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});
