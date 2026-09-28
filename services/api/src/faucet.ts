/**
 * The native-WBT faucet.
 *
 * WHY THIS IS NOT LIKE THE USDW FAUCET. USDW is minted by the collateral token's own
 * `claim()`, which the visitor's own wallet calls — the frontend never touches a key. WBT
 * is the chain's NATIVE gas coin, and there is no `claim()` to call: native balance can
 * only be moved by a transaction someone pays gas for. A wallet with zero WBT cannot pay
 * that gas, so it cannot bootstrap itself. This faucet is that bootstrap — a funded
 * server-side wallet SENDS a small amount of WBT to a requested address, which is what
 * then lets that address afford the USDW `claim()` and its first order. It is therefore
 * the one place in this read API that holds a spending key and signs a transaction.
 *
 * ABUSE. Addresses are free to mint, so a per-address limit alone is porous; the claim is
 * gated on address AND client IP, one payout per `FAUCET_COOLDOWN_HOURS` (24h) each. The
 * check-and-reserve is a single serialized transaction (advisory locks on address and IP)
 * so two simultaneous requests cannot both pass the window check and double-spend.
 *
 * FUNDING GATE. The dispensing wallet is generated separately and funded out of band; the
 * service must come up and stay healthy before it has any WBT in it. So a claim against an
 * unconfigured or empty wallet resolves to a clean 503 ("not configured" / "out of
 * funds") rather than a 500 or a raw RPC "insufficient funds" — the endpoint is safe to
 * ship dark and lights up the moment the wallet is funded.
 */

import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getPool } from './db.js';

/** Owned by this service alone, like `api_series` — never `public`, which belongs to
 * Ponder and is rebuilt on every indexer redeploy. */
const SCHEMA = 'api_faucet';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 1874);

export interface FaucetConfig {
  enabled: boolean;
  amountWei: bigint;
  cooldownHours: number;
}

/** The seam the whole module is testable through: a real one signs and broadcasts, a
 * fake one is injected by the suite so no test ever reaches a chain. */
export interface WbtSender {
  address: `0x${string}`;
  balance(): Promise<bigint>;
  send(to: `0x${string}`, amountWei: bigint): Promise<Hex>;
}

export type ClaimResult =
  | { ok: true; txHash: string; amountWei: bigint; from: `0x${string}` }
  | { ok: false; code: number; error: string; retryAfterSeconds?: number };

function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FaucetConfig {
  const rawHours = Number(env.FAUCET_COOLDOWN_HOURS ?? 24);
  return {
    // On by default; the endpoint still declines cleanly until the wallet exists and is
    // funded, so shipping it enabled-but-empty is the intended pre-funding state.
    enabled: (env.FAUCET_WBT_ENABLED ?? 'true') !== 'false',
    amountWei: parseEther(env.FAUCET_WBT_AMOUNT ?? '0.3'),
    cooldownHours: Number.isFinite(rawHours) && rawHours > 0 ? Math.floor(rawHours) : 24,
  };
}

function rpcUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.FAUCET_RPC_URLS ?? 'https://rpc.testnet.whitechain.io')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The dispensing key, in the same one-element `[{ address, private_key }]` shape every
 * role key on the box uses (docs/runbooks/deploy-server.md). Read here rather than via
 * `@whitespace/shared/keys` only because that module ships no type declaration. Never
 * logged. */
function loadKey(path: string): { address: `0x${string}`; privateKey: Hex } {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (!entry?.address || !entry?.private_key) {
    throw new Error(`faucet key file ${path} is not shaped like a role key file`);
  }
  return { address: entry.address, privateKey: entry.private_key };
}

let cachedSender: WbtSender | undefined;

function realSender(): WbtSender {
  if (cachedSender) return cachedSender;
  const keyPath = process.env.FAUCET_KEY_PATH ?? `${process.env.HOME}/.whitespace-keys/faucet.json`;
  const { privateKey } = loadKey(keyPath);
  const account = privateKeyToAccount(privateKey);
  const chain = defineChain({
    id: CHAIN_ID,
    name: `whitechain-${CHAIN_ID}`,
    nativeCurrency: { name: 'Whitechain', symbol: 'WBT', decimals: 18 },
    rpcUrls: { default: { http: rpcUrls() } },
  });
  const transport = http(rpcUrls()[0]);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  cachedSender = {
    address: account.address,
    balance: () => publicClient.getBalance({ address: account.address }),
    async send(to, amountWei) {
      // Whitechain is legacy type-0 — no EIP-1559 — so the transaction is priced from
      // eth_gasPrice exactly as every other sender in this repo does it
      // (packages/txsender/src/txSender.mjs). An EIP-1559 request here would be rejected
      // by the node.
      const gasPrice = await publicClient.getGasPrice();
      return walletClient.sendTransaction({ to, value: amountWei, gasPrice, type: 'legacy' });
    },
  };
  return cachedSender;
}

let testOverrides: { sender?: WbtSender; config?: Partial<FaucetConfig> } = {};

/** Test-only seam (see the header): inject a fake sender and/or config, or pass null to
 * reset. Never called in production code. */
export function __setFaucetTestOverrides(
  overrides: { sender?: WbtSender; config?: Partial<FaucetConfig> } | null,
): void {
  testOverrides = overrides ?? {};
  // A prior real sender must not survive an override that swaps in a fake one, nor a reset.
  cachedSender = undefined;
}

export async function ensureFaucetSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.faucet_claims (
      id          bigserial   PRIMARY KEY,
      address     text        NOT NULL,
      ip          text        NOT NULL,
      status      text        NOT NULL,
      tx_hash     text,
      amount_wei  numeric,
      claimed_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS faucet_claims_address_idx ON ${SCHEMA}.faucet_claims (address, claimed_at)`,
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS faucet_claims_ip_idx ON ${SCHEMA}.faucet_claims (ip, claimed_at)`);
}

type Reservation = { blockedRetryAfter: number } | { claimId: string };

/**
 * Atomically checks the cooldown and reserves a claim slot.
 *
 * The two advisory locks (address, IP) serialize concurrent requests that share either
 * key, so the window check below cannot be run twice before either insert is committed —
 * which is the only thing standing between a spammer and two payouts from one hammer of
 * the button. `pending` and `sent` rows both count against the window; `failed` rows do
 * not, so a send that never landed neither pays out nor locks the address for a day.
 */
async function reserveSlot(input: { address: string; ip: string }, config: FaucetConfig): Promise<Reservation> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.address]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.ip]);
    const blocked = await client.query<{ retry_after: number | null }>(
      `SELECT extract(epoch FROM (max(claimed_at) + make_interval(hours => $3::int) - now()))::int AS retry_after
         FROM ${SCHEMA}.faucet_claims
        WHERE status <> 'failed'
          AND claimed_at > now() - make_interval(hours => $3::int)
          AND (address = $1 OR ip = $2)`,
      [input.address, input.ip, config.cooldownHours],
    );
    const retryAfter = blocked.rows[0]?.retry_after ?? null;
    if (retryAfter != null && retryAfter > 0) {
      await client.query('ROLLBACK');
      return { blockedRetryAfter: retryAfter };
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.faucet_claims (address, ip, status, amount_wei)
       VALUES ($1, $2, 'pending', $3) RETURNING id`,
      [input.address, input.ip, config.amountWei.toString()],
    );
    await client.query('COMMIT');
    return { claimId: inserted.rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Sends `FAUCET_WBT_AMOUNT` WBT to `address`, once per cooldown per address and per IP.
 *
 * Order matters: reserve the slot first, then fund. A reserved slot that fails to fund is
 * flipped to `failed` so it stops counting — the visitor can immediately try again rather
 * than being locked out for a day by a transient RPC hiccup.
 */
export async function claimWbt(input: { address: string; ip: string }): Promise<ClaimResult> {
  const config = { ...loadConfigFromEnv(), ...testOverrides.config };
  if (!config.enabled) {
    return { ok: false, code: 503, error: 'The WBT faucet is currently disabled.' };
  }

  let sender: WbtSender;
  try {
    sender = testOverrides.sender ?? realSender();
  } catch {
    // No key file on the box yet — the funding gate. Decline cleanly.
    return { ok: false, code: 503, error: 'The WBT faucet is not configured yet.' };
  }

  const reservation = await reserveSlot(input, config);
  if ('blockedRetryAfter' in reservation) {
    return {
      ok: false,
      code: 429,
      error: 'This wallet or network has already claimed WBT. Try again later.',
      retryAfterSeconds: reservation.blockedRetryAfter,
    };
  }
  const { claimId } = reservation;

  const pool = getPool();
  const markFailed = () =>
    pool
      .query(`UPDATE ${SCHEMA}.faucet_claims SET status = 'failed' WHERE id = $1`, [claimId])
      .catch(() => undefined);

  // Don't reach for the network to move funds that aren't there: an empty wallet gets a
  // clean "out of funds", not a raw RPC revert.
  try {
    const balance = await sender.balance();
    if (balance < config.amountWei) {
      await markFailed();
      return { ok: false, code: 503, error: 'The WBT faucet is temporarily out of funds.' };
    }
  } catch {
    await markFailed();
    return { ok: false, code: 502, error: 'Could not reach the network to fund your wallet. Try again.' };
  }

  let txHash: string;
  try {
    txHash = await sender.send(input.address as `0x${string}`, config.amountWei);
  } catch {
    await markFailed();
    return { ok: false, code: 502, error: 'The funding transaction could not be sent. Try again.' };
  }

  await pool.query(`UPDATE ${SCHEMA}.faucet_claims SET status = 'sent', tx_hash = $2 WHERE id = $1`, [
    claimId,
    txHash,
  ]);
  return { ok: true, txHash, amountWei: config.amountWei, from: sender.address };
}
