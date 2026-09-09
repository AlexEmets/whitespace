import { ponder } from 'ponder:registry';
import { createPublicClient, http } from 'viem';
import { market } from '../../ponder.schema.js';
import { updateIfExists } from '../lib/db.js';
import { bytes32ToSymbol } from '../lib/bytes32.js';

// `context.client` pins every read to the block of the event being processed, which is
// correct in principle and unusable here in practice: the public 1874 RPC is not an
// archive node, and answers `eth_call` against a listing-era block with
// "state at block #7284584 is pruned". That aborts the whole historical sync, so no
// backfill can ever complete — the failure that blocked this indexer from ever reaching
// 100%.
//
// This client reads at `latest` instead, which the node does serve. That is sound for
// this particular read because the market row converges to the right value either way:
// every field it seeds is separately covered by an update event this indexer already
// handles (PairMaxLeverageUpdated, PairFeedUpdated, ...), and those replay in order on
// top of the seed. The seed is a starting point, not the final word.
//
// What it costs: during a backfill, a market row briefly shows today's configuration
// rather than the configuration as of its listing block. Nothing reads the row mid-sync
// — the API gates on `sync_status` — and the terminal state is correct.
const latestClient = createPublicClient({
  transport: http((process.env.PONDER_RPC_URLS_1874 ?? 'https://rpc.testnet.whitechain.io').split(',')[0]!.trim()),
});

// PairAdded does not carry feed/maxLeverage/groupIndex/feeIndex (verified
// against a real on-chain log — see abis/pairsStorage.ts), so this handler
// does one bounded `pairs(uint16)` read to seed the rest of the market row.
ponder.on('PairsStorage:PairAdded', async ({ event, context }) => {
  const pairIndex = event.args.index;

  const [from, to, feed, , , maxLeverage, groupIndex, feeIndex, oracle] = await latestClient.readContract({
    abi: context.contracts.PairsStorage.abi,
    address: context.contracts.PairsStorage.address,
    functionName: 'pairs',
    args: [pairIndex],
  });

  await context.db
    .insert(market)
    .values({
      pairIndex,
      fromSymbol: bytes32ToSymbol(from),
      toSymbol: bytes32ToSymbol(to),
      feedId: feed,
      oracle,
      groupIndex,
      feeIndex,
      maxLeverage,
      maxOpenInterest: 0n,
      openInterestLong: 0n,
      openInterestShort: 0n,
      updatedAtBlock: event.block.number,
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate({
      fromSymbol: bytes32ToSymbol(from),
      toSymbol: bytes32ToSymbol(to),
      feedId: feed,
      groupIndex,
      feeIndex,
      maxLeverage,
      updatedAtBlock: event.block.number,
      updatedAt: Number(event.block.timestamp),
    });
});

ponder.on('PairsStorage:PairMaxLeverageUpdated', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    market,
    { pairIndex: event.args.pairIndex },
    {
      maxLeverage: event.args.maxLeverage,
      updatedAtBlock: event.block.number,
      updatedAt: Number(event.block.timestamp),
    },
    'PairMaxLeverageUpdated',
  );
});

ponder.on('PairsStorage:PairFeedUpdated', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    market,
    { pairIndex: event.args.pairIndex },
    {
      feedId: event.args.feed,
      updatedAtBlock: event.block.number,
      updatedAt: Number(event.block.timestamp),
    },
    'PairFeedUpdated',
  );
});
