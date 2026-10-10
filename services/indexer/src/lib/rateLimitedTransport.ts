import type { Transport } from 'viem';

/**
 * Wraps a viem transport so it sends at most `rps` requests per second, queueing the rest.
 *
 * The public 1874 RPC rate-limits by IP, and the indexer, the keeper and both bots share the
 * box's one IP. Ponder sizes its own request rate from 20 rps upward until it sees errors, so
 * during a backfill it took the whole budget: the keeper's eth_blockNumber came back "rate
 * limit exceeded" and orders went unfilled, while Ponder itself crash-looped on the 429s. A
 * queued request only looks slow to Ponder; an error is what it was retrying (and logging)
 * on. This keeps the indexer under a fixed share and leaves the rest to the keeper.
 */
export function rateLimitedTransport(
  inner: Transport,
  { rps, now = () => Date.now(), sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }: {
    rps: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Transport {
  if (!(rps > 0)) throw new Error(`rateLimitedTransport: rps must be > 0, got ${rps}`);
  const interval = 1000 / rps;
  let nextSlot = 0;

  /** Reserves the next send slot and waits for it. Slots are handed out in call order. */
  async function slot(): Promise<void> {
    const t = now();
    const at = Math.max(t, nextSlot);
    nextSlot = at + interval;
    if (at > t) await sleep(at - t);
  }

  return ((config) => {
    const transport = inner(config);
    return {
      ...transport,
      request: (async (args: Parameters<typeof transport.request>[0], options?: Parameters<typeof transport.request>[1]) => {
        await slot();
        return transport.request(args, options);
      }) as typeof transport.request,
    };
  }) as Transport;
}

/** PONDER_MAX_RPS, default 5, 1..200. */
export function parseMaxRps(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error(`PONDER_MAX_RPS must be an integer in 1..200, got ${raw}`);
  return n;
}
