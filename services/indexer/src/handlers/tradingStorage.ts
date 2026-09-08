import { ponder } from 'ponder:registry';
import { market } from '../../ponder.schema.js';
import { updateIfExists } from '../lib/db.js';

ponder.on('TradingStorage:MaxOpenInterestUpdated', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    market,
    { pairIndex: event.args.pairIndex },
    {
      maxOpenInterest: event.args.value,
      updatedAtBlock: event.block.number,
      updatedAt: Number(event.block.timestamp),
    },
    'MaxOpenInterestUpdated',
  );
});
