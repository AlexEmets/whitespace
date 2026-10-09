import type { Address } from 'viem';
import { CHAIN_ID } from './config';

/**
 * The trader's open vault request, per direction, kept in the browser.
 *
 * A request lives for a settlement or more (withdrawals for `withdrawSettlementDelay` epochs),
 * far longer than the dialog that made it. It used to exist only in that dialog's state, so a
 * reload — or opening the dialog from /vaults instead of /portfolio — showed no request at all:
 * no Claim, no Cancel, no Reclaim, and shares that had left "Your shares" with nothing leading
 * back to them. The chain stays the source of truth for the amount and status; this only
 * remembers WHICH settlement to ask about.
 */
export type VaultRequestKind = 'deposit' | 'withdraw';

export interface VaultRequest {
  id: number;
  amountRaw: bigint;
}

type MaybeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;

function defaultStorage(): MaybeStorage {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function vaultRequestKey(owner: Address, kind: VaultRequestKind, chainId: number = CHAIN_ID): string {
  return `whitespace:vault:${chainId}:${owner.toLowerCase()}:${kind}`;
}

export function loadVaultRequest(owner: Address, kind: VaultRequestKind, storage: MaybeStorage = defaultStorage()): VaultRequest | null {
  try {
    const raw = storage?.getItem(vaultRequestKey(owner, kind));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; amountRaw?: unknown };
    if (!Number.isInteger(parsed.id) || typeof parsed.amountRaw !== 'string' || !/^\d+$/.test(parsed.amountRaw)) return null;
    return { id: parsed.id as number, amountRaw: BigInt(parsed.amountRaw) };
  } catch {
    return null;
  }
}

export function saveVaultRequest(
  owner: Address,
  kind: VaultRequestKind,
  request: VaultRequest,
  storage: MaybeStorage = defaultStorage(),
): void {
  try {
    storage?.setItem(vaultRequestKey(owner, kind), JSON.stringify({ id: request.id, amountRaw: request.amountRaw.toString() }));
  } catch {
    // No persistence: the request still shows for this dialog's lifetime.
  }
}

export function clearVaultRequest(owner: Address, kind: VaultRequestKind, storage: MaybeStorage = defaultStorage()): void {
  try {
    storage?.removeItem(vaultRequestKey(owner, kind));
  } catch {
    // nothing persisted to remove
  }
}
