/**
 * Graceful stop for a process supervisor (systemd sends SIGTERM, then SIGKILL after
 * TimeoutStopSec). Stops scheduling, lets an in-flight sweep — possibly mid-send —
 * finish within `graceMs`, then closes resources. Idempotent: a second signal while
 * stopping returns the same promise.
 */

/**
 * @param {object} opts
 * @param {{ stop: () => void, running: boolean, runOnce: () => Promise<unknown> }} opts.loop
 * @param {(() => unknown)[]} [opts.stoppers] synchronous stops (watchers, timers)
 * @param {(() => Promise<unknown>)[]} [opts.closers] async closes (http server, db pool)
 * @param {number} [opts.graceMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {() => Promise<{ timedOut: boolean }>}
 */
export function createShutdown({ loop, stoppers = [], closers = [], graceMs = 20_000, log = () => {} }) {
  let stopping = null;
  return function shutdown() {
    if (stopping) return stopping;
    stopping = (async () => {
      loop.stop();
      for (const s of stoppers) s();
      let timedOut = false;
      if (loop.running) {
        log('waiting for the in-flight sweep to finish');
        let timer;
        const grace = new Promise((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, graceMs);
        });
        await Promise.race([loop.runOnce().catch(() => {}), grace]);
        clearTimeout(timer);
      }
      await Promise.allSettled(closers.map((c) => c()));
      return { timedOut };
    })();
    return stopping;
  };
}
