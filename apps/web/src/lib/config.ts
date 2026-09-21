import { PRICE_DECIMALS } from '@whitespace/shared/decimal';
import { CHAINS } from '@whitespace/shared/chains';
import { MIN_HEALTHY_VENUES } from '@whitespace/shared/bounds';

/** Price always carries this many decimals on-chain and in the API — reused from
 * @whitespace/shared, never redefined. */
export const PRICE_DECIMALS_NUM = Number(PRICE_DECIMALS);

/** Collateral (USDW) decimals. Matches contracts/src/mocks/USDW.sol `decimals()` (6),
 * chosen to match the USDC the vendored Ostium contracts expect. packages/shared does
 * not export a collateral-decimals constant, so this is the one place it is pinned. */
export const COLLATERAL_DECIMALS = 6;

/** Leverage PRECISION_2, per IOstiumTradingStorage.Trade.leverage (e.g. 1000 = 10.00x). */
export const LEVERAGE_DECIMALS = 2;

export const CHAIN_ID = 1874;

const chainInfo = CHAINS[CHAIN_ID];
if (!chainInfo) {
  throw new Error(`@whitespace/shared/chains has no entry for chain ${CHAIN_ID}`);
}
export const CHAIN_INFO = chainInfo;

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';

/**
 * JSON-RPC endpoint this app's own chain reads go to. Defaults to the public Whitechain
 * endpoint, so absent the env var the behaviour is exactly what it is today and local
 * development is unaffected. In the hosted deployment it points at `/rpc` on our own
 * origin, which eRPC fronts (hosting design §5): N visitors then collapse into one cached
 * outbound client instead of N independent sources of rate-limit pressure queued against
 * the indexer and keeper on the single known 1874 endpoint.
 *
 * Deliberately NOT folded into the chain's `rpcUrls` in wagmiConfig: that value is what
 * `wallet_addEthereumChain` hands the visitor's wallet, and their wallet should keep
 * pointing at the canonical public endpoint rather than becoming dependent on this
 * deployment's domain staying alive.
 */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? chainInfo.rpc;

/** Re-exported so callers can gate on "degraded" using the same threshold the publisher
 * enforces, instead of a locally re-typed magic number. */
export const MIN_HEALTHY_VENUES_REEXPORT = MIN_HEALTHY_VENUES;

/**
 * Default slippage tolerance, in bps of the execution price. Design §5.1: this is the
 * trader's ONLY defence against an unfavourable execution price in the two-phase flow
 * (the price is not known at request time), so the default must be tight, not the loose
 * "1-2%" a spot DEX might default to.
 */
export const DEFAULT_SLIPPAGE_BPS = 50n; // 0.50%
export const MIN_SLIPPAGE_BPS = 10n; // 0.10%
export const MAX_SLIPPAGE_BPS = 500n; // 5.00% — above this we consider the trader's
// downside protection meaningless and warn.
