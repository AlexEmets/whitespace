/**
 * Wires a watcher event to a report source and a tx sender. This is the seam the
 * "timestamp must be byte-identical" property is tested against: `handlePriceRequested`
 * takes the already-decoded event (whose `timestamp` came straight off the
 * PriceRequestedV2 log) and passes it through unmodified to the report source. The clock
 * is read only to decide how long retrying is still worthwhile — never to replace the
 * order's timestamp.
 *
 * Report fetches are retried with exponential backoff until the order's report deadline
 * (order timestamp + maxAge). After that the chain would reject the report as too old,
 * so the order is given up on with the last reason logged; the trader's collateral comes
 * back through the timeout reclaim.
 */

import { encodePerformData } from '@whitespace/reporter';
import { getMarketByFeedId } from '@whitespace/shared/markets';
import { CONTRACT_REPORT_MAX_AGE_S } from '@whitespace/shared/bounds';

export const DEFAULT_INITIAL_BACKOFF_MS = 250;
export const DEFAULT_MAX_BACKOFF_MS = 2_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Worth asking again? A network failure (no status), 409 (the publisher refuses to sign
 * right now: degraded, no data, mark stale), 429 and 5xx are all conditions that clear.
 * 400/404 (bad request, unknown feed, timestamp outside the signing window) do not.
 * @param {{ status?: number }} result
 */
export function isRetryableReportFailure(result) {
  const { status } = result;
  return status === undefined || status === 409 || status === 429 || status >= 500;
}

/**
 * @param {object} opts
 * @param {{ getSignedReport: (req: { feed: string, timestamp: number, orderTypeName: string }) => Promise<{ ok: true, signedReport: `0x${string}` } | { ok: false, reason: string, status?: number }> }} opts.reportSource
 * @param {{ send: (args: { orderId: bigint, performData: `0x${string}` }) => Promise<{ ok: boolean }> }} opts.txSender
 * @param {(entry: { orderId: bigint, reason: string }) => void} [opts.onGiveUp] an order
 *   that could not get a report before its deadline
 * @param {(entry: { orderId: bigint, reason: string, attempt: number, waitMs: number }) => void} [opts.onRetry]
 * @param {number} [opts.maxAgeS] report maxAge enforced on chain
 * @param {number} [opts.initialBackoffMs]
 * @param {number} [opts.maxBackoffMs]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
export function createKeeperEngine({
  reportSource,
  txSender,
  onGiveUp = () => {},
  onRetry = () => {},
  maxAgeS = CONTRACT_REPORT_MAX_AGE_S,
  initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  now = () => Date.now(),
  sleep = defaultSleep,
}) {
  function giveUp(orderId, reason) {
    onGiveUp({ orderId, reason });
    return { ok: false, reason, gaveUp: true };
  }

  /**
   * @param {{ orderId: bigint, orderTypeName: string, feed: `0x${string}`, timestamp: number }} event
   */
  async function handlePriceRequested(event) {
    const market = getMarketByFeedId(event.feed);
    const feedName = market ? market.feed : event.feed;
    const deadlineMs = (event.timestamp + maxAgeS) * 1000;

    if (now() >= deadlineMs) {
      return giveUp(event.orderId, `expired: order timestamp ${event.timestamp} is older than maxAge ${maxAgeS}s`);
    }

    let backoff = initialBackoffMs;
    for (let attempt = 1; ; attempt++) {
      const reportResult = await reportSource.getSignedReport({
        feed: feedName,
        timestamp: event.timestamp, // verbatim from the log — never Date.now()
        orderTypeName: event.orderTypeName,
      });

      if (reportResult.ok) {
        const performData = encodePerformData(reportResult.signedReport, event.orderId);
        return txSender.send({ orderId: event.orderId, performData });
      }

      if (!isRetryableReportFailure(reportResult)) {
        return giveUp(event.orderId, `no_report:${reportResult.reason}`);
      }
      // Only sleep if there is still time to ask again after waking.
      if (now() + backoff >= deadlineMs) {
        return giveUp(event.orderId, `report_deadline_passed after ${attempt} attempt(s): ${reportResult.reason}`);
      }
      onRetry({ orderId: event.orderId, reason: reportResult.reason, attempt, waitMs: backoff });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  }

  return { handlePriceRequested };
}
