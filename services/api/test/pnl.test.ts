import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedClosedPosition, seedOpenPosition, seedFee, TRADER } from './seed.js';
import { getPool } from '../src/db.js';

describe('GET /pnl/:address', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  const get = async (path: string) => {
    const res = await fetch(`${server.baseUrl}${path}`);
    return { status: res.status, body: await res.json() };
  };

  it('is all zeros for a trader with no closed positions', async () => {
    expect((await get(`/pnl/${TRADER}`)).body).toEqual({
      realizedPnl: '0.000000',
      fees: '0.000000',
      funding: '0.000000',
      trades: 0,
    });
  });

  it('sums realized PnL, fees and signed funding over closed trades only', async () => {
    // The real proof trade: 999 USDW in, 998.692628 back -> -0.307372.
    await seedClosedPosition();
    await getPool().query(
      `INSERT INTO closed_position (trade_id, trader, pair_index, index, buy, collateral, leverage, open_price, close_price, tp, sl, close_reason, percent_profit, usdc_sent_to_trader, percentage_closed, open_order_id, close_order_id, opened_at, closed_at, close_tx_hash)
       VALUES (7, $1, 0, 1, false, 100000000, 500, 1, 1, 0, 0, 'tp', 0, 150000000, 10000, 7, 8, 1, 2, '0x01')`,
      [TRADER],
    );
    // Trade 2 (closed): counted.
    await seedFee('0x1-0', 'dev', '1000000', { tradeId: 2 });
    await seedFee('0x1-1', 'oracle', '250000', { tradeId: 2 });
    await seedFee('0x1-2-rollover', 'rollover', '-10', { tradeId: 2 });
    await seedFee('0x1-2-funding', 'funding', '-500000', { tradeId: 2 });
    // Trade 7 (closed): counted.
    await seedFee('0x2-0', 'vault_opening', '20', { tradeId: 7 });
    await seedFee('0x2-1', 'bond', '30', { tradeId: 7 });
    await seedFee('0x2-2-funding', 'funding', '200000', { tradeId: 7 });
    // Excluded: the liquidation remainder, an open trade, and a fee with no trade.
    await seedFee('0x3-0', 'vault_liq', '999999', { tradeId: 7 });
    await seedFee('0x3-1', 'dev', '5555', { tradeId: 99 });
    await seedFee('0x3-2', 'oracle', '7777', { tradeId: null });
    await seedOpenPosition();

    expect((await get(`/pnl/${TRADER}`)).body).toEqual({
      realizedPnl: '49.692628', // -0.307372 + 50
      fees: '1.250040', // 1 + 0.25 - 0.00001 + 0.00002 + 0.00003
      funding: '-0.300000',
      trades: 2,
    });
  });

  it("does not count another trader's fees on the same trade id", async () => {
    await seedClosedPosition();
    await seedFee('0x1-0', 'dev', '1000000', { tradeId: 2, trader: `0x${'00'.repeat(19)}bb` });
    expect((await get(`/pnl/${TRADER}`)).body.fees).toBe('0.000000');
  });

  it('400 on a malformed address', async () => {
    const { status, body } = await get('/pnl/0x12');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid address' });
  });
});
