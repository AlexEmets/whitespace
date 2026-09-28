/**
 * Single-flight sweep scheduler.
 *
 * The previous loop was `setInterval(async () => sweep())`: a sweep slower than the
 * interval (a slow RPC, a receipt wait) let the next tick start a second sweep on top of
 * it, both reading the same candidates and both submitting the same triggers against
 * one nonce. Here the next sweep is scheduled only after the current one settles, and
 * `runOnce()` called while a sweep is in flight joins that sweep instead of starting
 * another. At most one sweep is ever running.
 */

/**
 * @template T
 * @param {object} opts
 * @param {() => Promise<T>} opts.sweep
 * @param {number} opts.intervalMs gap between the end of one sweep and the start of the next
 * @param {(err: unknown) => void} [opts.onError]
 */
export function createSweepLoop({ sweep, intervalMs, onError = () => {} }) {
  if (!(intervalMs > 0)) throw new Error(`createSweepLoop: intervalMs must be > 0, got ${intervalMs}`);

  /** @type {Promise<T> | null} */
  let inFlight = null;
  let timer = null;
  let stopped = true;

  function runOnce() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        return await sweep();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    try {
      await runOnce();
    } catch (err) {
      onError(err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  return {
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      tick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get running() {
      return inFlight !== null;
    },
  };
}
