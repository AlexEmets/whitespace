/**
 * Mark price = EMA(index), so a single tick cannot trigger a liquidation cascade
 * (design spec §5.2). Implemented as a fixed-cadence discrete EMA rather than a
 * continuous-time one: the driver samples the current index once per
 * `sampleIntervalMs` and feeds it to `update()`. That turns the "10s window" into an
 * exact integer smoothing factor alpha = 2/(N+1), N = windowMs/sampleIntervalMs,
 * instead of needing a floating-point exp(-dt/tau) on every irregular WS tick.
 *
 * The only floating point in this module is `Math.round` used once, at construction,
 * to derive N (a period *count*, not a price) from two millisecond durations — never
 * applied to a price value. All price arithmetic is exact bigint.
 */

import { MARK_EMA_WINDOW_MS, MARK_EMA_SAMPLE_INTERVAL_MS } from '@whitespace/shared/bounds';

/**
 * @param {object} [opts]
 * @param {number} [opts.windowMs]
 * @param {number} [opts.sampleIntervalMs]
 */
export function createMarkEma({ windowMs = MARK_EMA_WINDOW_MS, sampleIntervalMs = MARK_EMA_SAMPLE_INTERVAL_MS } = {}) {
  const periods = Math.max(1, Math.round(windowMs / sampleIntervalMs));
  const alphaNum = 2n;
  const alphaDen = BigInt(periods + 1);
  let value = null;

  return {
    windowMs,
    sampleIntervalMs,
    periods,
    alphaNum,
    alphaDen,
    get value() {
      return value;
    },
    /**
     * @param {bigint|null} indexValue
     * @returns {bigint|null} the updated EMA value
     */
    update(indexValue) {
      if (indexValue === null || indexValue === undefined) return value;
      value = value === null ? indexValue : value + ((indexValue - value) * alphaNum) / alphaDen;
      return value;
    },
    reset() {
      value = null;
    },
  };
}
