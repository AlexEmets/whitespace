import { ponder } from 'ponder:registry';
import { syncStatus } from '../../ponder.schema.js';

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
});
