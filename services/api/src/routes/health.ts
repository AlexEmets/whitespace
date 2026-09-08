import { queryOne } from '../db.js';
import type { RouteResult } from '../router.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 1874);
const DEGRADED_LAG_SECONDS = 30;
const DOWN_LAG_SECONDS = 300;

export async function handleHealth(): Promise<RouteResult> {
  const row = await queryOne<{ block_number: string; block_timestamp: number }>(
    'SELECT block_number, block_timestamp FROM sync_status WHERE chain_id = $1',
    [CHAIN_ID],
  );

  if (!row) {
    return {
      code: 200,
      body: { status: 'down', chainId: CHAIN_ID, indexedBlock: null, lagSeconds: null },
    };
  }

  const lagSeconds = Math.max(0, Math.floor(Date.now() / 1000) - row.block_timestamp);
  const status = lagSeconds > DOWN_LAG_SECONDS ? 'down' : lagSeconds > DEGRADED_LAG_SECONDS ? 'degraded' : 'ok';

  return {
    code: 200,
    body: { status, chainId: CHAIN_ID, indexedBlock: row.block_number, lagSeconds },
  };
}
