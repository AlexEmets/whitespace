/**
 * Ambient type declarations for @whitespace/shared's plain-ESM subpath exports (see
 * packages/shared/package.json). The package ships untyped .mjs source with no build
 * step; these declarations describe its real shape (read directly from src/*.mjs) so
 * apps/web gets type safety without modifying packages/shared, which this app only
 * reuses.
 */

// '@whitespace/shared/decimal' is not declared here: the package ships its own
// src/decimal.d.ts (see its package.json "exports"), and an ambient block would shadow it.

declare module '@whitespace/shared/markets' {
  export interface Market {
    feed: string;
    feedId: `0x${string}`;
    venueSymbols: Record<string, string>;
  }
  export const MARKETS: Record<string, Market>;
  export const MARKET_FEEDS: string[];
  export function getMarket(feed: string): Market;
  export function getMarketByFeedId(feedId: `0x${string}`): Market | undefined;
  export function asciiToBytes32Hex(str: string): `0x${string}`;
}

declare module '@whitespace/shared/chains' {
  export interface ChainInfo {
    id: number;
    name: string;
    rpc: string;
    expects: Record<string, boolean>;
  }
  export const CHAINS: Record<number, ChainInfo>;
}

declare module '@whitespace/shared/bounds' {
  export const MIN_HEALTHY_VENUES: number;
  export const CONTRACT_MARKET_ORDERS_TIMEOUT_BLOCKS: number;
}
