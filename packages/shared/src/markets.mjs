/**
 * The market registry: the single place mapping a feed id to its on-chain bytes32
 * encoding and to each venue's symbol for that market. Both services/price-publisher
 * and services/keeper read this instead of hardcoding feed strings or venue symbols.
 *
 * BTC and ETH are the launch markets per the design spec §1 ("BTC and ETH are fixed").
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
