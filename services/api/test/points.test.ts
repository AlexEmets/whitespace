import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import {
  truncateAll,
  seedWalletPoints,
  seedWalletStreak,
  seedWalletLp,
  seedMissionEvent,
  TRADER,
  OTHER_TRADER,
} from './seed.js';

describe('GET /points/:address', () => {
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

  it('returns a genuine zero for a wallet that has earned nothing', async () => {
    expect((await get(`/points/${TRADER}`)).body).toEqual({
      address: TRADER,
      missions: '0.000000',
      time: '0.000000',
      streak: '0.000000',
      lp: '0.000000',
      total: '0.000000',
      rank: null,
      streakDays: 0,
      streakLongest: 0,
      completedMissions: [],
      updatedAt: null,
      lpBalance: '0.000000',
      lpSince: null,
    });
  });

  it('sums the four components, resolves the streak and lists unlocked missions', async () => {
    await seedWalletPoints({ missions: '500000000', time: '214600000', streak: '128000000', lp: '96400000', updatedAt: 1788881880 });
    await seedWalletStreak({ currentLength: 5, longest: 6 });
    await seedWalletLp({ balanceRaw: '8500000000', lastAccrualAt: 1788881000 });
    await seedMissionEvent('first_market_trade', { at: 100 });
    await seedMissionEvent('edit_tp_sl', { at: 200 });

    expect((await get(`/points/${TRADER}`)).body).toEqual({
      address: TRADER,
      missions: '500.000000',
      time: '214.600000',
      streak: '128.000000',
      lp: '96.400000',
      total: '939.000000',
      rank: 1,
      streakDays: 5,
      streakLongest: 6,
      completedMissions: ['first_market_trade', 'edit_tp_sl'],
      updatedAt: 1788881880,
      lpBalance: '8500.000000',
      lpSince: 1788881000,
    });
  });

  it('ranks a wallet below everyone with a higher total', async () => {
    await seedWalletPoints({ trader: TRADER, missions: '500000000' });
    await seedWalletPoints({ trader: OTHER_TRADER, missions: '850000000' });
    expect((await get(`/points/${TRADER}`)).body.rank).toBe(2);
    expect((await get(`/points/${OTHER_TRADER}`)).body.rank).toBe(1);
  });

  it('matches the address case-insensitively and echoes it lowercased', async () => {
    await seedWalletPoints({ missions: '50000000' });
    const body = (await get(`/points/${TRADER.toUpperCase().replace('0X', '0x')}`)).body;
    expect(body.address).toBe(TRADER);
    expect(body.total).toBe('50.000000');
  });

  it('does not leak another wallet into the completed-missions list', async () => {
    await seedWalletPoints({ trader: OTHER_TRADER, missions: '50000000' });
    await seedMissionEvent('first_market_trade', { trader: OTHER_TRADER });
    expect((await get(`/points/${TRADER}`)).body.completedMissions).toEqual([]);
  });

  it('400 on a malformed address', async () => {
    const { status, body } = await get('/points/0x12');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid address' });
  });
});

describe('GET /points/leaderboard', () => {
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

  it('is an empty array when nobody has points', async () => {
    expect((await get('/points/leaderboard')).body).toEqual([]);
  });

  it('ranks wallets by total points descending', async () => {
    await seedWalletPoints({ trader: TRADER, missions: '500000000' });
    await seedWalletPoints({ trader: OTHER_TRADER, missions: '850000000' });
    expect((await get('/points/leaderboard')).body).toEqual([
      { rank: 1, address: OTHER_TRADER, missions: '850.000000', time: '0.000000', streak: '0.000000', lp: '0.000000', total: '850.000000' },
      { rank: 2, address: TRADER, missions: '500.000000', time: '0.000000', streak: '0.000000', lp: '0.000000', total: '500.000000' },
    ]);
  });

  it('honours the limit', async () => {
    await seedWalletPoints({ trader: TRADER, missions: '500000000' });
    await seedWalletPoints({ trader: OTHER_TRADER, missions: '850000000' });
    const body = (await get('/points/leaderboard?limit=1')).body;
    expect(body).toHaveLength(1);
    expect(body[0].address).toBe(OTHER_TRADER);
  });

  it('does not collide with the :address route', async () => {
    // "leaderboard" must hit the leaderboard handler, not be parsed as an address.
    const { status } = await get('/points/leaderboard');
    expect(status).toBe(200);
  });
});
