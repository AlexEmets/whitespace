/**
 * Two ways for the keeper to obtain a signed report — "fetches or builds" (task spec):
 *  - HttpReportSource: the production path, fetches a report from price-publisher's
 *    HTTP API.
 *  - LocalReportSource: builds and signs one directly from locally held signer keys.
 *    Mainly for standalone/dev/test runs (e.g. against anvil with no publisher
 *    process running) — see docs/decisions/phase-3-price-publisher.md for when this
 *    is and isn't appropriate to use.
 *
 * Both return the same shape: { ok: true, signedReport } | { ok: false, reason, status? }.
 * `status` is the publisher's HTTP status; the engine uses it to tell a refusal that will
 * clear (409, 5xx) from one that will not (400, 404). A network failure has none.
 * Neither ever fabricates the timestamp — it is always the caller-supplied value.
 */

import { buildReportDataV2, signAndEncodeReportV2 } from '@whitespace/reporter/report-v2';
import { getMarket } from '@whitespace/shared/markets';

/**
 * @param {string} baseUrl e.g. 'http://127.0.0.1:8787'
 * @param {typeof fetch} [fetchImpl]
 */
export function createHttpReportSource(baseUrl, fetchImpl = fetch) {
  return {
    /**
     * @param {{ feed: string, timestamp: number, orderTypeName: string }} req
     */
    async getSignedReport({ feed, timestamp, orderTypeName }) {
      const url = new URL('/v2/report', baseUrl);
      url.searchParams.set('feed', feed);
      url.searchParams.set('timestamp', String(timestamp));
      url.searchParams.set('orderType', orderTypeName);
      let res;
      try {
        res = await fetchImpl(url);
      } catch (err) {
        return { ok: false, reason: `fetch_failed:${err.message}` };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: body.error ?? `http_${res.status}`, status: res.status };
      }
      const body = await res.json();
      return { ok: true, signedReport: body.signedReport };
    },
  };
}

/**
 * @param {object} opts
 * @param {number} opts.chainId
 * @param {`0x${string}`} opts.verifierAddress
 * @param {{ address: `0x${string}`, privateKey: `0x${string}` }[]} opts.signerKeys
 * @param {(feed: string, orderTypeName: string) => Promise<{ price: bigint, bid?: bigint, ask?: bigint }|null>} opts.getMarketPrice
 */
export function createLocalReportSource({ chainId, verifierAddress, signerKeys, getMarketPrice }) {
  return {
    async getSignedReport({ feed, timestamp, orderTypeName }) {
      const priceInfo = await getMarketPrice(feed, orderTypeName);
      if (!priceInfo) return { ok: false, reason: 'no_price' };
      const market = getMarket(feed);
      const reportData = buildReportDataV2({
        chainId,
        verifier: verifierAddress,
        feedId: market.feedId,
        timestamp,
        price: priceInfo.price,
        bid: priceInfo.bid ?? priceInfo.price,
        ask: priceInfo.ask ?? priceInfo.price,
        isMarketOpen: true,
        isDayTradingClosed: false,
      });
      const { signedReport } = await signAndEncodeReportV2(
        reportData,
        signerKeys.map((k) => k.privateKey),
      );
      return { ok: true, signedReport };
    },
  };
}
