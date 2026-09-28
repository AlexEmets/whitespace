import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { parseEther } from 'viem';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll } from './seed.js';
import { __setFaucetTestOverrides, type WbtSender } from '../src/faucet.js';

/**
 * The WBT faucet is the one write in an otherwise read-only API, and the one place a key
 * signs a transaction — so its tests exercise the HTTP endpoint end to end (routing, body
 * parsing, status codes, the Postgres cooldown ledger) with only the chain itself faked.
 * The fake `WbtSender` is the seam from src/faucet.ts; nothing here reaches a real node.
 *
 * The client IP is controlled per-request through `X-Forwarded-For`, exactly as Caddy
 * feeds it in production — every request in this suite otherwise originates from loopback
 * and would share one IP, which would make the per-address and per-IP limits impossible
 * to tell apart.
 */

const AMOUNT = parseEther('0.3');
const FAUCET_ADDRESS = '0xc6f802bca0b1d94db536a61fd4dcbba7333ed7b8' as const;

type SenderCall = { to: string; amountWei: bigint };

function makeSender(opts: { balance?: bigint; failSend?: boolean; failBalance?: boolean } = {}): {
  sender: WbtSender;
  calls: SenderCall[];
} {
  const calls: SenderCall[] = [];
  const sender: WbtSender = {
    address: FAUCET_ADDRESS,
    balance: async () => {
      if (opts.failBalance) throw new Error('rpc down');
      return opts.balance ?? parseEther('1000');
    },
    send: async (to, amountWei) => {
      calls.push({ to, amountWei });
      if (opts.failSend) throw new Error('broadcast failed');
      return '0xdeadbeef' as `0x${string}`;
    },
  };
  return { sender, calls };
}

async function claim(baseUrl: string, address: string, ip: string) {
  return fetch(`${baseUrl}/faucet/wbt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ address }),
  });
}

const ADDR_A = '0x1111111111111111111111111111111111111111';
const ADDR_B = '0x2222222222222222222222222222222222222222';
const IP_1 = '203.0.113.1';
const IP_2 = '203.0.113.2';

describe('POST /faucet/wbt', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    __setFaucetTestOverrides(null);
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
  });
  afterEach(() => {
    __setFaucetTestOverrides(null);
  });

  it('sends WBT to the requested address and reports the tx hash', async () => {
    const { sender, calls } = makeSender();
    __setFaucetTestOverrides({ sender });

    const res = await claim(server.baseUrl, ADDR_A, IP_1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, txHash: '0xdeadbeef', amountWei: AMOUNT.toString(), from: FAUCET_ADDRESS });

    expect(calls).toHaveLength(1);
    // The address is lowercased before it is paid, so the cooldown key and the payout
    // target are the same string regardless of how the caller cased it.
    expect(calls[0]).toEqual({ to: ADDR_A, amountWei: AMOUNT });
  });

  it('lowercases a checksummed address before paying and keying the cooldown', async () => {
    const { sender, calls } = makeSender();
    __setFaucetTestOverrides({ sender });

    const checksummed = '0xAbCdeF0000000000000000000000000000000001';
    const res = await claim(server.baseUrl, checksummed, IP_1);
    expect(res.status).toBe(200);
    expect(calls[0]!.to).toBe(checksummed.toLowerCase());
  });

  it('rejects a malformed address with 400 and never sends', async () => {
    const { sender, calls } = makeSender();
    __setFaucetTestOverrides({ sender });

    const res = await claim(server.baseUrl, '0xnothex', IP_1);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a body that is not valid JSON with 400', async () => {
    const { sender } = makeSender();
    __setFaucetTestOverrides({ sender });

    const res = await fetch(`${server.baseUrl}/faucet/wbt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP_1 },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('blocks a second claim from the same address within the cooldown, even from a new IP', async () => {
    const { sender, calls } = makeSender();
    __setFaucetTestOverrides({ sender });

    expect((await claim(server.baseUrl, ADDR_A, IP_1)).status).toBe(200);

    const res = await claim(server.baseUrl, ADDR_A, IP_2);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
    // The blocked attempt must not have paid out a second time.
    expect(calls).toHaveLength(1);
  });

  it('blocks a second claim from the same IP within the cooldown, even for a new address', async () => {
    const { sender, calls } = makeSender();
    __setFaucetTestOverrides({ sender });

    expect((await claim(server.baseUrl, ADDR_A, IP_1)).status).toBe(200);

    const res = await claim(server.baseUrl, ADDR_B, IP_1);
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it('lets a different address on a different IP claim independently', async () => {
    const { sender, calls } = makeSender();
    __setFaucetTestOverrides({ sender });

    expect((await claim(server.baseUrl, ADDR_A, IP_1)).status).toBe(200);
    expect((await claim(server.baseUrl, ADDR_B, IP_2)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('declines with 503 when the wallet holds less than the payout', async () => {
    const { sender, calls } = makeSender({ balance: parseEther('0.1') });
    __setFaucetTestOverrides({ sender });

    const res = await claim(server.baseUrl, ADDR_A, IP_1);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0); // never attempted the send
  });

  it('a failed send does not consume the cooldown — the address can retry at once', async () => {
    const failing = makeSender({ failSend: true });
    __setFaucetTestOverrides({ sender: failing.sender });

    const first = await claim(server.baseUrl, ADDR_A, IP_1);
    expect(first.status).toBe(502);
    expect(failing.calls).toHaveLength(1);

    // Swap in a working sender; the same address/IP must not be locked out by the failure.
    const working = makeSender();
    __setFaucetTestOverrides({ sender: working.sender });
    const second = await claim(server.baseUrl, ADDR_A, IP_1);
    expect(second.status).toBe(200);
    expect(working.calls).toHaveLength(1);
  });

  it('reports 503 when the faucet is disabled by config', async () => {
    const { sender, calls } = makeSender();
    __setFaucetTestOverrides({ sender, config: { enabled: false } });

    const res = await claim(server.baseUrl, ADDR_A, IP_1);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('reports 503 (not configured) when no dispensing key is present', async () => {
    // No override sender: claimWbt falls through to the real sender, which reads the key
    // file at FAUCET_KEY_PATH. Point it at a path that does not exist.
    const prev = process.env.FAUCET_KEY_PATH;
    process.env.FAUCET_KEY_PATH = '/nonexistent/faucet.json';
    __setFaucetTestOverrides(null);
    try {
      const res = await claim(server.baseUrl, ADDR_A, IP_1);
      expect(res.status).toBe(503);
    } finally {
      if (prev === undefined) delete process.env.FAUCET_KEY_PATH;
      else process.env.FAUCET_KEY_PATH = prev;
    }
  });
});
