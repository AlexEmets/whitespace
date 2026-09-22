/**
 * The market registry: the single place mapping a feed id to its on-chain bytes32
 * encoding and to each venue's symbol for that market. Both services/price-publisher
 * and services/keeper read this instead of hardcoding feed strings or venue symbols.
 *
 * BTC and ETH are the launch markets per the design spec §1 ("BTC and ETH are fixed").
 * SOL was added afterwards. The bar for a new entry is not "the pair exists" but "enough
 * independent sources clear the venue filters", since below the market's healthy-source
 * minimum the aggregator marks the feed degraded and never signs an opening report (see
 * services/price-publisher/src/aggregator.mjs and @whitespace/shared/bounds).
 *
 * BTC, ETH and SOL each meet that bar the ordinary way: all four exchanges quote them,
 * verified live on 2026-09-10 and again on 2026-09-22 (worst spread 5.43 bps, on WhiteBIT
 * SOL, against a 10 bps bound).
 *
 * WBT/USD is the exception and is listed on WhiteBIT's own two books. Measured 2026-09-22:
 * Binance, Bybit and OKX do not list WBT at all; MEXC (28.9 bps) and Kraken (30.1 bps) do,
 * but quote ~3x wider than VENUE_SPREAD_WIDTH_BOUND_BPS, so adapters for them would only
 * produce ticks the aggregator rejects. WhiteBIT's own books are inside the bound —
 * WBT_USDT at 1.04 bps and WBT_PERP at 3.12 bps, mids agreeing to 0.46 bps — and carry the
 * real volume ($68.9M and $140.8M/24h, the perp book out-trading BTC_USDT there).
 * See MARKET_BOUNDS_OVERRIDES in ./bounds.mjs for the threshold this implies and the
 * single-exchange risk it accepts.
 */

/**
 * Right-pads an ASCII string into a 32-byte hex literal, matching Solidity's
 * `bytes32("BTC/USD")` and viem's `stringToHex(s, { size: 32 })`. Implemented with
 * Node's built-in Buffer so this package stays dependency-free.
 * @param {string} str
 * @returns {`0x${string}`}
 */
export function asciiToBytes32Hex(str) {
  const bytes = Buffer.from(str, 'utf8');
  if (bytes.length > 32) {
    throw new Error(`asciiToBytes32Hex: "${str}" is longer than 32 bytes`);
  }
  const padded = Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]);
  return `0x${padded.toString('hex')}`;
}

/** @typedef {{ feed: string, feedId: `0x${string}`, venueSymbols: Record<string, string> }} Market */

/** @type {Record<string, Market>} */
export const MARKETS = {
  'BTC/USD': {
    feed: 'BTC/USD',
    feedId: asciiToBytes32Hex('BTC/USD'),
    venueSymbols: {
      binance: 'BTCUSDT',
      bybit: 'BTCUSDT',
      okx: 'BTC-USDT',
      whitebit: 'BTC_USDT',
    },
  },
  'ETH/USD': {
    feed: 'ETH/USD',
    feedId: asciiToBytes32Hex('ETH/USD'),
    venueSymbols: {
      binance: 'ETHUSDT',
      bybit: 'ETHUSDT',
      okx: 'ETH-USDT',
      whitebit: 'ETH_USDT',
    },
  },
  'SOL/USD': {
    feed: 'SOL/USD',
    feedId: asciiToBytes32Hex('SOL/USD'),
    venueSymbols: {
      binance: 'SOLUSDT',
      bybit: 'SOLUSDT',
      okx: 'SOL-USDT',
      whitebit: 'SOL_USDT',
    },
  },
  'WBT/USD': {
    feed: 'WBT/USD',
    feedId: asciiToBytes32Hex('WBT/USD'),
    venueSymbols: {
      whitebit: 'WBT_USDT',
      whitebit_perp: 'WBT_PERP',
    },
  },
};

export const MARKET_FEEDS = Object.keys(MARKETS);

/**
 * @param {string} feed
 * @returns {Market}
 */
export function getMarket(feed) {
  const market = MARKETS[feed];
  if (!market) throw new Error(`getMarket: unknown feed "${feed}"`);
  return market;
}

/**
 * Reverse lookup: the on-chain `bytes32 feed` a PriceRequestedV2 log carries back to
 * the registry entry (and hence its human-readable feed name).
 * @param {`0x${string}`} feedId
 * @returns {Market|undefined}
 */
export function getMarketByFeedId(feedId) {
  const needle = feedId.toLowerCase();
  return Object.values(MARKETS).find((m) => m.feedId.toLowerCase() === needle);
}
