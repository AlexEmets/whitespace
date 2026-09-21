import { createPublicClient, http } from 'viem';

// `context.client` pins every read to the block of the event being processed, which is
// correct in principle and unusable here in practice: the public 1874 RPC is not an
// archive node, and answers `eth_call` against a listing-era block with
// "state at block #7284584 is pruned". That aborts the whole historical sync, so no
// backfill can ever complete.
//
// This client reads at `latest` instead, which the node does serve. That is sound for the
// reads it is used for because the market row converges to the right value either way:
// every field it seeds is separately covered by an update event this indexer already
// handles (PairMaxLeverageUpdated, PairFeedUpdated, ...), and those replay in order on
// top of the seed. The seed is a starting point, not the final word.
//
// What it costs: during a backfill, a market row briefly shows today's configuration
// rather than the configuration as of its listing block. Nothing reads the row mid-sync
// — the API gates on `sync_status` — and the terminal state is correct.
//
// Shared by the PairAdded handler and by seedMarketsFromChain, which need identical
// semantics — one definition so the reasoning above has one home.
export const latestClient = createPublicClient({
  transport: http((process.env.PONDER_RPC_URLS_1874 ?? 'https://rpc.testnet.whitechain.io').split(',')[0]!.trim()),
});
