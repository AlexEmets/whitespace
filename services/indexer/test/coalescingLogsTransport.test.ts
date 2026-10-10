import { describe, expect, it } from 'vitest';
import { custom } from 'viem';
import { coalescingLogsTransport } from '../src/lib/coalescingLogsTransport.js';

const A = '0x0aC538e15e4C7a27E6E38025Bed911B8975044F0';
const B = '0x1E0DBa1e028eE40A0096dD63eaBadB5b4A7c2c99';
const T1 = '0x' + '11'.repeat(32);
const T2 = '0x' + '22'.repeat(32);
const T3 = '0x' + '33'.repeat(32);
const LOGS = [
  { logIndex: '0x0', topics: [T1, '0x' + '00'.repeat(32)] },
  { logIndex: '0x1', topics: [T2] },
  { logIndex: '0x2', topics: [T1] },
  { logIndex: '0x3', topics: [] },
];

function harness(opts: { ttlMs?: number; maxEntries?: number; fail?: () => boolean } = {}) {
  let clock = 0;
  const sent: any[] = [];
  const inner = custom({
    request: async (args: any) => {
      sent.push(args);
      if (opts.fail?.()) throw new Error('rate limit exceeded');
      return args.method === 'eth_getLogs' ? LOGS : '0x1';
    },
  });
  const transport = coalescingLogsTransport(inner, { ttlMs: opts.ttlMs, maxEntries: opts.maxEntries, now: () => clock })({ retryCount: 0 } as any); // as Ponder calls it
  const getLogs = (p: Record<string, unknown>) =>
    transport.request({ method: 'eth_getLogs', params: [p] } as any) as Promise<any[]>;
  return { transport, sent, getLogs, tick: (ms: number) => (clock += ms) };
}

const range = { fromBlock: '0x97dff7', toBlock: '0x97e034' };

describe('coalescingLogsTransport', () => {
  it("answers Ponder's one-request-per-event pattern with one request per contract", async () => {
    const { sent, getLogs } = harness();
    const [r1, r2, r3] = await Promise.all([
      getLogs({ address: A, topics: [T1], ...range }),
      getLogs({ address: A, topics: [T2], ...range }),
      getLogs({ address: A, topics: [T3], ...range }),
    ]);
    expect(sent).toEqual([{ method: 'eth_getLogs', params: [{ address: A.toLowerCase(), ...range }] }]);
    expect(r1.map((l) => l.logIndex)).toEqual(['0x0', '0x2']);
    expect(r2.map((l) => l.logIndex)).toEqual(['0x1']);
    expect(r3).toEqual([]);
  });

  it('serves a caller that arrives after the fetch resolved, within the TTL', async () => {
    const { sent, getLogs, tick } = harness({ ttlMs: 30_000 });
    await getLogs({ address: A, topics: [T1], ...range });
    tick(29_000);
    expect((await getLogs({ address: A, topics: [T2], ...range })).map((l) => l.logIndex)).toEqual(['0x1']);
    expect(sent).toHaveLength(1);
  });

  it('fetches again once the TTL has passed', async () => {
    const { sent, getLogs, tick } = harness({ ttlMs: 30_000 });
    await getLogs({ address: A, topics: [T1], ...range });
    tick(30_001);
    await getLogs({ address: A, topics: [T1], ...range });
    expect(sent).toHaveLength(2);
  });

  it('keeps different addresses and ranges apart', async () => {
    const { sent, getLogs } = harness();
    await getLogs({ address: A, topics: [T1], ...range });
    await getLogs({ address: B, topics: [T1], ...range });
    await getLogs({ address: A, topics: [T1], fromBlock: '0x97e035', toBlock: '0x97e100' });
    expect(sent).toHaveLength(3);
  });

  it('matches topic0 case-insensitively and accepts a topic0 list', async () => {
    const { getLogs } = harness();
    expect((await getLogs({ address: A, topics: [T1.toUpperCase().replace('0X', '0x')], ...range })).length).toBe(2);
    expect((await getLogs({ address: A, topics: [[T1, T2]], ...range })).map((l) => l.logIndex)).toEqual(['0x0', '0x1', '0x2']);
  });

  it('returns every log when no topic is given', async () => {
    const { getLogs } = harness();
    expect(await getLogs({ address: A, ...range })).toEqual(LOGS);
    expect(await getLogs({ address: A, topics: [], ...range })).toEqual(LOGS);
  });

  it('coalesces an address list regardless of order and case', async () => {
    const { sent, getLogs } = harness();
    await getLogs({ address: [A, B], topics: [T1], ...range });
    await getLogs({ address: [B.toLowerCase(), A], topics: [T2], ...range });
    expect(sent).toHaveLength(1);
    expect(sent[0].params[0].address).toEqual([A.toLowerCase(), B.toLowerCase()].sort());
  });

  it('does not keep a failed fetch: every waiting caller sees the error and the next one retries', async () => {
    let failing = true;
    const { sent, getLogs } = harness({ fail: () => failing });
    const results = await Promise.allSettled([
      getLogs({ address: A, topics: [T1], ...range }),
      getLogs({ address: A, topics: [T2], ...range }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(sent).toHaveLength(1);
    failing = false;
    expect((await getLogs({ address: A, topics: [T1], ...range })).length).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it('bounds the number of cached ranges', async () => {
    const { sent, getLogs } = harness({ maxEntries: 2 });
    for (const from of ['0x1', '0x2', '0x3']) await getLogs({ address: A, topics: [T1], fromBlock: from, toBlock: from });
    await getLogs({ address: A, topics: [T1], fromBlock: '0x1', toBlock: '0x1' });
    expect(sent).toHaveLength(4);
  });

  it('passes through anything it cannot answer from a whole-contract fetch', async () => {
    const { sent, transport, getLogs } = harness();
    const passthrough = [
      { address: A, topics: [T1, T2], ...range }, // topic1 filter
      { address: A, topics: [null], ...range },
      { topics: [T1], ...range }, // no address
      { address: A, topics: [T1], fromBlock: '0x1', toBlock: 'latest' },
      { address: A, topics: [T1], blockHash: '0x' + 'ab'.repeat(32) },
      { address: [], topics: [T1], ...range },
    ];
    for (const p of passthrough) await getLogs(p);
    await transport.request({ method: 'eth_blockNumber' } as any);
    expect(sent.map((s) => s.params?.[0] ?? s.method)).toEqual([...passthrough, 'eth_blockNumber']);
  });
});
