import { ponder } from 'ponder:registry';
import { market } from '../../ponder.schema.js';
import { updateIfExists } from '../lib/db.js';
import { bytes32ToSymbol } from '../lib/bytes32.js';
import { latestClient } from '../lib/latestClient.js';

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
