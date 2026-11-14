import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, TX_A } from './seed.js';
import { getPool } from '../src/db.js';

async function seedSettlement(id: number, full = true): Promise<void> {
  if (full) {
    await getPool().query(
      `INSERT INTO vault_settlement VALUES ($1, 'acct', 1788880000, 1000000000, 990000000, 1010000000000000000,
        -5000000000000000000, -3000000, -12, 7, 5000000, 15000000, -10000000, 1788880001, 7285000, $2)`,
      [id, TX_A],
    );
  } else {
    await getPool().query(
      `INSERT INTO vault_settlement (id, share_to_assets_price, at, block_number, tx_hash) VALUES ($1, 1000000000000000000, 5, 6, $2)`,
      [id, TX_A],
    );
  }
}

describe('GET /vault/settlements', () => {
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

  it('returns the exact VaultSettlement shape with signed values', async () => {
    await seedSettlement(4);
    expect((await get('/vault/settlements')).body).toEqual([
      {
        settlementId: 4,
        settlementType: 'acct',
        settlementTs: 1788880000,
        totalAssets: '1000.000000',
        totalSupply: '990.000000',
        shareToAssetsPrice: '1.010000000000000000',
        settlementOpenPnl: '-5.000000000000000000',
        totalClosedPnl: '-3.000000',
        accPnlPerTokenUsed: '-0.000000000000000012',
        bufferSize: '0.000007',
        assetsDeposited: '5.000000',
        sharesWithdrawn: '15.000000',
        deltaShares: '-10.000000',
        at: 1788880001,
        blockNumber: '7285000',
        txHash: TX_A,
      },
    ]);
  });

  it('keeps nulls for a settlement whose second event is not indexed yet', async () => {
    await seedSettlement(1, false);
    const [s] = (await get('/vault/settlements')).body;
    expect(s).toMatchObject({ settlementId: 1, totalAssets: null, deltaShares: null, settlementType: null, shareToAssetsPrice: '1.000000000000000000' });
  });

  it('newest first, default 50, ?limit honoured', async () => {
    for (let i = 1; i <= 55; i++) await seedSettlement(i, false);
    const all = (await get('/vault/settlements')).body;
    expect(all).toHaveLength(50);
    expect(all[0].settlementId).toBe(55);
    expect((await get('/vault/settlements?limit=2')).body.map((s: { settlementId: number }) => s.settlementId)).toEqual([55, 54]);
  });

  it.each(['0', '501', 'ten'])('400 on ?limit=%s', async (limit) => {
    expect((await get(`/vault/settlements?limit=${limit}`)).status).toBe(400);
  });
});

describe('GET /vault/performance', () => {
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

  const T = 1_790_000_000;
  const DAY = 86_400;

  it('is a 404 before the vault has settled once', async () => {
    expect(await get('/vault/performance')).toEqual({ status: 404, body: { error: 'no vault settlements indexed yet' } });
  });

  it('measures the share price between settlements, placing one without a settlement time at its block time', async () => {
    // The full row carries settlement_ts; the partial ones only `at`, which the route falls back to.
    await getPool().query(
      `INSERT INTO vault_settlement (id, share_to_assets_price, at, block_number, tx_hash)
         VALUES (1, 1000000000000000000, $1, 1, $3), (2, 1004000000000000000, $2, 2, $3)`,
      [T, T + 3 * DAY, TX_A],
    );
    await getPool().query(
      `INSERT INTO vault_settlement (id, settlement_type, settlement_ts, total_assets, share_to_assets_price, at, block_number, tx_hash)
         VALUES (3, 'acct', $1, 2500000000000, 1010000000000000000, $2, 3, $3)`,
      [T + 7 * DAY, T + 7 * DAY + 5, TX_A],
    );
    const { status, body } = await get('/vault/performance');
    expect(status).toBe(200);
    expect(body).toMatchObject({ sharePrice: '1.010000000000000000', totalAssets: '2500000.000000', updatedAt: T + 7 * DAY });
    expect(body.windows['7d']).toEqual({
      from: T,
      sharePriceThen: '1.000000000000000000',
      change: '0.010000000000000000',
      apr: '0.521428571428571428',
    });
    expect(body.windows['30d']).toBeNull();
    expect(body.series.map((p: { sharePrice: string }) => p.sharePrice)).toEqual([
      '1.000000000000000000',
      '1.004000000000000000',
      '1.010000000000000000',
    ]);
  });
});
