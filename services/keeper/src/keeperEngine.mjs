/**
 * Wires a watcher event to a report source and a tx sender. This is the seam the
 * "timestamp must be byte-identical" property is tested against: `handlePriceRequested`
 * takes the already-decoded event (whose `timestamp` came straight off the
 * PriceRequestedV2 log) and passes it through unmodified to the report source — no
 * clock read happens anywhere in this file.
 */

import { encodePerformData } from '@whitespace/reporter';
import { getMarketByFeedId } from '@whitespace/shared/markets';

/**
 * @param {object} opts
 * @param {{ getSignedReport: (req: { feed: string, timestamp: number, orderTypeName: string }) => Promise<{ ok: true, signedReport: `0x${string}` } | { ok: false, reason: string }> }} opts.reportSource
 * @param {{ send: (args: { orderId: bigint, performData: `0x${string}` }) => Promise<{ ok: boolean }> }} opts.txSender
 * @param {(entry: { orderId: bigint, reason: string }) => void} [opts.onDeadLetter]
 */
export function createKeeperEngine({ reportSource, txSender, onDeadLetter = () => {} }) {
  /**
   * @param {{ orderId: bigint, orderTypeName: string, feed: `0x${string}`, timestamp: number }} event
   */
  async function handlePriceRequested(event) {
    const market = getMarketByFeedId(event.feed);
    const feedName = market ? market.feed : event.feed;

    const reportResult = await reportSource.getSignedReport({
      feed: feedName,
      timestamp: event.timestamp, // verbatim from the log — never Date.now()
      orderTypeName: event.orderTypeName,
    });

    if (!reportResult.ok) {
      onDeadLetter({ orderId: event.orderId, reason: `no_report:${reportResult.reason}` });
      return { ok: false, reason: reportResult.reason };
    }

    const performData = encodePerformData(reportResult.signedReport, event.orderId);
    return txSender.send({ orderId: event.orderId, performData });
  }

  return { handlePriceRequested };
}
