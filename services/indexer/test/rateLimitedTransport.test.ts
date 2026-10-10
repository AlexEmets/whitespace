import { describe, expect, it } from 'vitest';
import { custom } from 'viem';
import { parseMaxRps, rateLimitedTransport } from '../src/lib/rateLimitedTransport.js';

function harness(rps: number) {
  let clock = 0;
  const sentAt: number[] = [];
  const inner = custom({
    request: async () => {
      sentAt.push(clock);
      return '0x1';
    },
  });
  const transport = rateLimitedTransport(inner, {
    rps,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  })({});
  return { transport, sentAt };
}

describe('rateLimitedTransport', () => {
  it('spaces a burst out to the configured rate instead of sending it at once', async () => {
    const { transport, sentAt } = harness(5);
    for (let i = 0; i < 6; i++) await transport.request({ method: 'eth_blockNumber' });
    expect(sentAt).toEqual([0, 200, 400, 600, 800, 1000]);
  });

  it('passes requests and results through unchanged', async () => {
    const { transport } = harness(10);
    expect(await transport.request({ method: 'eth_chainId' })).toBe('0x1');
  });

  it('does not delay a request once the rate has room again', async () => {
    let clock = 0;
    const sentAt: number[] = [];
    const t = rateLimitedTransport(custom({ request: async () => (sentAt.push(clock), '0x1') }), {
      rps: 2,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    })({});
    await t.request({ method: 'a' });
    clock = 5_000;
    await t.request({ method: 'b' });
    expect(sentAt).toEqual([0, 5_000]);
  });

  it('refuses a non-positive rate', () => {
    expect(() => rateLimitedTransport(custom({ request: async () => null }), { rps: 0 })).toThrow(/rps/);
  });
});

describe('parseMaxRps', () => {
  it('defaults to 5 and accepts 1..200', () => {
    expect(parseMaxRps(undefined)).toBe(5);
    expect(parseMaxRps('')).toBe(5);
    expect(parseMaxRps('1')).toBe(1);
    expect(parseMaxRps('200')).toBe(200);
  });
  it('refuses anything else', () => {
    for (const bad of ['0', '201', '2.5', 'x']) expect(() => parseMaxRps(bad)).toThrow(/PONDER_MAX_RPS/);
  });
});
