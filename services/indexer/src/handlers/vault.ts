import { ponder } from 'ponder:registry';
import { lpActivity } from '../../ponder.schema.js';

// See the comment on `type Db = any` in src/lib/db.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

async function record(
  db: Db,
  kind: string,
  owner: `0x${string}`,
  settlementId: number,
  amount: bigint,
  logIndex: number,
  timestamp: number,
  blockNumber: bigint,
  txHash: `0x${string}`,
): Promise<void> {
  await db
    .insert(lpActivity)
    .values({
      id: `${kind}-${owner}-${settlementId}-${logIndex}`,
      owner,
      kind,
      settlementId,
      amount,
      timestamp,
      blockNumber,
      txHash,
    })
    .onConflictDoUpdate({});
}

ponder.on('Vault:DepositRequestedV2', async ({ event, context }) => {
  await record(
    context.db,
    'deposit_requested',
    event.args.owner,
    event.args.settlementId,
    event.args.assets,
    event.log.logIndex,
    Number(event.block.timestamp),
    event.block.number,
    event.transaction.hash,
  );
});

ponder.on('Vault:WithdrawRequestedV2', async ({ event, context }) => {
  await record(
    context.db,
    'withdraw_requested',
    event.args.owner,
    event.args.settlementId,
    event.args.shares,
    event.log.logIndex,
    Number(event.block.timestamp),
    event.block.number,
    event.transaction.hash,
  );
});

ponder.on('Vault:DepositClaimedV2', async ({ event, context }) => {
  await record(
    context.db,
    'deposit_claimed',
    event.args.owner,
    event.args.settlementId,
    event.args.shares,
    event.log.logIndex,
    Number(event.block.timestamp),
    event.block.number,
    event.transaction.hash,
  );
});

ponder.on('Vault:WithdrawClaimedV2', async ({ event, context }) => {
  await record(
    context.db,
    'withdraw_claimed',
    event.args.owner,
    event.args.settlementId,
    event.args.assets,
    event.log.logIndex,
    Number(event.block.timestamp),
    event.block.number,
    event.transaction.hash,
  );
});
