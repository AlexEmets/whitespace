import type { Transport } from 'viem';

type Log = { topics?: readonly string[] };
type Entry = { promise: Promise<Log[]>; at: number };

/**
 * Serves Ponder's per-event `eth_getLogs` calls from one per-contract request.
 *
 * Ponder 0.16 means to merge every event of a contract into one `eth_getLogs` with a topic0
 * list, but it only merges filters whose topic1..3 are `undefined`, and its config builder sets
 * them to `null` for any event without indexed-argument filters — i.e. always. So each step of a
 * backfill sent one request per (contract, event): ~50 for this ABI set. Its step sizing aims
 * for 10 s per step, and once the per-IP RPC budget caps the request rate, a step's duration no
 * longer depends on its range, so the range shrank to ~60 blocks and a 100k-block catch-up took
 * about 11 hours while starving the keeper of the same budget.
 *
 * A request for one address (or one address list), a numeric block range and only a topic0 (or none) is answered by
 * fetching every log of that address over that range once and filtering locally; concurrent and
 * recent callers for the same address and range share that fetch. Anything else passes through.
 */
export function coalescingLogsTransport(
  inner: Transport,
  { ttlMs = 30_000, maxEntries = 64, now = () => Date.now() }: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): Transport {
  const cache = new Map<string, Entry>();

  function evict(t: number) {
    for (const [key, entry] of cache) {
      if (t - entry.at > ttlMs || cache.size > maxEntries) cache.delete(key);
      else break; // insertion order: the rest are newer
    }
  }

  return ((config) => {
    const transport = inner(config);
    const request = (async (args: Parameters<typeof transport.request>[0], options?: Parameters<typeof transport.request>[1]) => {
      const plan = args.method === 'eth_getLogs' ? planFor(args.params) : undefined;
      if (!plan) return transport.request(args, options);

      const t = now();
      evict(t);
      let entry = cache.get(plan.key);
      if (!entry || t - entry.at > ttlMs) {
        const promise = transport.request(
          { method: 'eth_getLogs', params: [{ address: plan.address, fromBlock: plan.fromBlock, toBlock: plan.toBlock }] },
          options,
        ) as Promise<Log[]>;
        entry = { promise, at: t };
        cache.delete(plan.key);
        cache.set(plan.key, entry);
        const stored = entry;
        // A failed fetch must not be served to later callers; they retry with a fresh one.
        promise.catch(() => {
          if (cache.get(plan.key) === stored) cache.delete(plan.key);
        });
        evict(t);
      }
      const logs = await entry.promise;
      if (!plan.topic0) return logs;
      return logs.filter((log) => {
        const first = log.topics?.[0]?.toLowerCase();
        return first !== undefined && plan.topic0!.has(first);
      });
    }) as typeof transport.request;
    return { ...transport, request };
  }) as Transport;
}

const HEX = /^0x[0-9a-fA-F]+$/;

/** The shared-fetch key and local filter for a coalescable request, or undefined to pass it through. */
function planFor(params: unknown):
  | { key: string; address: string | string[]; fromBlock: string; toBlock: string; topic0: Set<string> | undefined }
  | undefined {
  if (!Array.isArray(params) || params.length !== 1) return undefined;
  const p = params[0] as Record<string, unknown>;
  if (!p || typeof p !== 'object') return undefined;
  if (Object.keys(p).some((k) => !['address', 'fromBlock', 'toBlock', 'topics'].includes(k))) return undefined;
  const { address, fromBlock, toBlock, topics } = p;
  let addr: string | string[];
  if (typeof address === 'string' && HEX.test(address)) addr = address.toLowerCase();
  else if (Array.isArray(address) && address.length > 0 && address.every((a) => typeof a === 'string' && HEX.test(a)))
    addr = [...new Set((address as string[]).map((a) => a.toLowerCase()))].sort();
  else return undefined;
  if (typeof fromBlock !== 'string' || !HEX.test(fromBlock)) return undefined;
  if (typeof toBlock !== 'string' || !HEX.test(toBlock)) return undefined;

  let topic0: Set<string> | undefined;
  if (topics === undefined || (Array.isArray(topics) && topics.length === 0)) topic0 = undefined;
  else if (!Array.isArray(topics) || topics.length !== 1) return undefined;
  else if (typeof topics[0] === 'string') topic0 = new Set([topics[0].toLowerCase()]);
  else if (Array.isArray(topics[0]) && topics[0].length > 0 && topics[0].every((t) => typeof t === 'string'))
    topic0 = new Set((topics[0] as string[]).map((t) => t.toLowerCase()));
  else return undefined;

  const from = fromBlock.toLowerCase();
  const to = toBlock.toLowerCase();
  return { key: `${[addr].flat().join(',')}|${from}|${to}`, address: addr, fromBlock: from, toBlock: to, topic0 };
}
