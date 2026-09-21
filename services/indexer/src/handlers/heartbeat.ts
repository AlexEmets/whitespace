import { ponder } from 'ponder:registry';
import { syncStatus } from '../../ponder.schema.js';
import { seedMarketsFromChain } from '../lib/seedMarkets.js';

// Runs on every block of chain 1874 (see the `blocks.ChainHeartbeat` source
// in ponder.config.ts). Backs GET /health's indexedBlock/lagSeconds — kept
// separate from the log-driven handlers so /health reflects real sync
// progress even during quiet periods with no matching contract events.
ponder.on('ChainHeartbeat:block', async ({ event, context }) => {
  await context.db
    .insert(syncStatus)
    .values({
      chainId: context.chain.id,
      blockNumber: event.block.number,
      blockTimestamp: Number(event.block.timestamp),
    })
    .onConflictDoUpdate({
      blockNumber: event.block.number,
      blockTimestamp: Number(event.block.timestamp),
    });

  // The market list cannot come from logs on this endpoint — PairAdded is inside the
  // pruned range — so it is reconstructed from contract state instead. Hung off the
  // heartbeat because that is the one source guaranteed to fire regardless of contract
  // activity; the helper guards itself so the chain is read at most once per boot.
  await seedMarketsFromChain(context.db, context.contracts, event.block);
});
