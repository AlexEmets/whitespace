import { ponder } from 'ponder:registry';
import { toMeta } from '../lib/event.js';
import { recordLpActivity } from '../lib/lpActivity.js';
import { onSettlementExecuted, onAsyncDepositWithdrawExecuted } from '../lib/vaultSettlement.js';
import { onVaultDepositClaimed, onVaultWithdrawClaimed } from '../lib/lpPoints.js';

// --- Per-LP activity (lp_activity; see src/lib/lpActivity.ts for the kinds) ----------
// One ponder.on per event: Ponder registers handlers by literal event name.

ponder.on('Vault:DepositRequestedV2', async ({ event, context }) => {
  await recordLpActivity(context.db, 'DepositRequestedV2', event.args, toMeta(event));
});
ponder.on('Vault:WithdrawRequestedV2', async ({ event, context }) => {
  await recordLpActivity(context.db, 'WithdrawRequestedV2', event.args, toMeta(event));
});
ponder.on('Vault:DepositClaimedV2', async ({ event, context }) => {
  await recordLpActivity(context.db, 'DepositClaimedV2', event.args, toMeta(event));
  await onVaultDepositClaimed(context.db, event.args, toMeta(event));
});
ponder.on('Vault:WithdrawClaimedV2', async ({ event, context }) => {
  await recordLpActivity(context.db, 'WithdrawClaimedV2', event.args, toMeta(event));
  await onVaultWithdrawClaimed(context.db, event.args, toMeta(event));
});
ponder.on('Vault:RequestDepositCanceledV2', async ({ event, context }) => {
  await recordLpActivity(context.db, 'RequestDepositCanceledV2', event.args, toMeta(event));
});
ponder.on('Vault:RequestWithdrawCanceledV2', async ({ event, context }) => {
  await recordLpActivity(context.db, 'RequestWithdrawCanceledV2', event.args, toMeta(event));
});
ponder.on('Vault:DepositReclaimedV2', async ({ event, context }) => {
  await recordLpActivity(context.db, 'DepositReclaimedV2', event.args, toMeta(event));
});
ponder.on('Vault:WithdrawReclaimedV2', async ({ event, context }) => {
  await recordLpActivity(context.db, 'WithdrawReclaimedV2', event.args, toMeta(event));
});
ponder.on('Vault:DepositPartiallyRefunded', async ({ event, context }) => {
  await recordLpActivity(context.db, 'DepositPartiallyRefunded', event.args, toMeta(event));
});

// --- Settlements (vault_settlement; see src/lib/vaultSettlement.ts) -----------------

ponder.on('Vault:SettlementExecuted', async ({ event, context }) => {
  await onSettlementExecuted(context.db, event.args, toMeta(event));
});

ponder.on('Vault:AsyncDepositWithdrawExecuted', async ({ event, context }) => {
  await onAsyncDepositWithdrawExecuted(context.db, event.args, toMeta(event));
});
