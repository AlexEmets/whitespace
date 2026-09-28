import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import WebSocket from 'ws';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket, seedPriceReport, TRADER, seedOpenPosition, seedLimitOrder, seedFee } from './seed.js';
import { parseChannel } from '../src/ws.js';

function onceMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitForCondition(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('WS /ws', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ wsPollIntervalMs: 30 });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedMarket();
  });

  it('acks a subscribe message with {type: "subscribed", channel}', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    const ack = await onceMessage(ws);
    expect(ack).toEqual({ type: 'subscribed', channel: 'price:0' });
    ws.close();
  });

  it('rejects a subscribe to a malformed channel with {type: "error"}', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'not-a-real-channel' }));
    const ack = await onceMessage(ws);
    expect(ack.type).toBe('error');
    ws.close();
  });

  it('pushes a price update to a subscribed client when a new price report lands', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    await onceMessage(ws); // the "subscribed" ack

    const updatePromise = onceMessage(ws);
    await seedPriceReport('65001000000000000000000', 1788881876, 2);
    const update = await updatePromise;
    expect(update.type).toBe('update');
    expect(update.channel).toBe('price:0');
    expect((update.data as { index: string }).index).toBe('65001.000000000000000000');
    ws.close();
  });

  it('does NOT push to a client that unsubscribed (filter proven both ways: A stays subscribed, B unsubscribes)', async () => {
    const a = await connect(server.wsUrl);
    const b = await connect(server.wsUrl);

    a.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    await onceMessage(a);
    b.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    await onceMessage(b);

    b.send(JSON.stringify({ type: 'unsubscribe', channel: 'price:0' }));
    await onceMessage(b); // "unsubscribed" ack

    let bReceivedUpdate = false;
    b.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'update') bReceivedUpdate = true;
    });

    const aUpdatePromise = onceMessage(a);
    await seedPriceReport('65001000000000000000000', 1788881876, 2);

    // A (still subscribed) must receive the update.
    const aUpdate = await aUpdatePromise;
    expect(aUpdate.type).toBe('update');

    // B (unsubscribed) must NOT have received it, even though A did — this
    // proves the filter actually discriminates rather than either
    // broadcasting to everyone or silently dropping everyone.
    expect(bReceivedUpdate).toBe(false);

    a.close();
    b.close();
  });

  it('stops pushing to a channel entirely once its only subscriber disconnects', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    await onceMessage(ws);
    ws.close();
    await waitForCondition(() => server.app.wsManager.channelSubscriberCount('price:0') === 0);
    expect(server.app.wsManager.channelSubscriberCount('price:0')).toBe(0);
  });

  it('supports the positions:<address> channel and reflects the real proof position', async () => {
    await seedOpenPosition();
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: `positions:${TRADER}` }));
    await onceMessage(ws);
    await server.app.wsManager.pollOnce();
    const update = await onceMessage(ws);
    expect(update.type).toBe('update');
    const data = update.data as Array<{ tradeId: string; collateral: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].tradeId).toBe('2');
    expect(data[0].collateral).toBe('999.000000');
    ws.close();
  });

  it('supports the candles:<pairIndex>:<interval> channel', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'candles:0:1m' }));
    await onceMessage(ws);
    ws.close();
  });

  async function subscribeAndWaitForUpdate(channel: string, seed: () => Promise<void>) {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel }));
    expect(await onceMessage(ws)).toEqual({ type: 'subscribed', channel });
    const updates: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => updates.push(JSON.parse(raw.toString())));
    await seed();
    await waitForCondition(() => updates.some((u) => Array.isArray(u.data) && (u.data as unknown[]).length > 0));
    ws.close();
    return updates.find((u) => Array.isArray(u.data) && (u.data as unknown[]).length > 0)!;
  }

  it('supports limitOrders:<address> with the REST shape', async () => {
    const update = await subscribeAndWaitForUpdate(`limitOrders:${TRADER}`, () => seedLimitOrder());
    expect(update.channel).toBe(`limitOrders:${TRADER}`);
    const [order] = update.data as Array<Record<string, unknown>>;
    expect(order).toMatchObject({ id: `${TRADER}-0-0`, orderType: 'LIMIT', collateral: '50.000000', triggerPrice: '60000.000000000000000000' });
    const rest = await (await fetch(`${server.baseUrl}/limit-orders/${TRADER}`)).json();
    expect(update.data).toEqual(rest);
  });

  it('supports fees:<address> with the REST shape', async () => {
    const update = await subscribeAndWaitForUpdate(`fees:${TRADER}`, () => seedFee('0xa-1-funding', 'funding', '-5'));
    const rest = await (await fetch(`${server.baseUrl}/fees/${TRADER}`)).json();
    expect(update.data).toEqual(rest);
    expect((update.data as Array<{ amount: string }>)[0].amount).toBe('-0.000005');
  });

  it.each(['limitOrders:0x12', 'fees:nope', 'limitOrders:', 'fees'])('rejects the malformed channel %s', async (channel) => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel }));
    expect((await onceMessage(ws)).type).toBe('error');
    ws.close();
  });
});

describe('parseChannel', () => {
  it('lowercases the address of the new wallet channels', () => {
    expect(parseChannel('fees:0x2B8BA090DEdF879F8045C0DDa5a78762CED90D19')).toEqual({
      kind: 'fees',
      args: ['0x2b8ba090dedf879f8045c0dda5a78762ced90d19'],
    });
    expect(parseChannel(`limitOrders:${TRADER}`)).toEqual({ kind: 'limitOrders', args: [TRADER] });
  });
});
