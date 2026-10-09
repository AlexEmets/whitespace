import {
  createWalletClient,
  encodeFunctionData,
  http,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TRADING_ABI } from './abi';
import { whitechainTestnet1874 } from './chain';
import { CHAIN_ID, RPC_URL } from './config';

/**
 * One-click trading session key.
 *
 * A session key is a fresh EOA generated in the browser and registered on-chain as the
 * trader's *delegate* (OstiumTrading.setDelegate). Once registered, the terminal signs every
 * trade with this local key — no wallet popup — by wrapping the real call in
 * `delegatedAction(trader, calldata)`, which the contract executes as the trader.
 *
 * WHY THIS IS SAFE ENOUGH TO HOLD IN THE BROWSER. The delegate can only *trade*. Every
 * OstiumTrading function pays out and refunds to `_msgSender()` (the trader), and the four
 * delegation-management selectors are forbidden inside delegatedAction, so a leaked key can
 * open and close positions but cannot move funds to itself, re-point the delegation, or
 * renew it. The blast radius is bounded by the USDW allowance the trader has granted and by
 * adverse trading — not by outright theft. It is still a hot key: it is testnet-only for now,
 * revocable on-chain at any time (removeDelegate), and wiped from storage on revoke/disconnect.
 *
 * The private key is stored in localStorage, namespaced by chain id and trader address, so a
 * wallet's key never leaks across accounts or chains. Storage is best-effort: a private window
 * or a blocked origin simply means no persisted session (the caller falls back to popups).
 */
export const SESSION_KEY_STORAGE_PREFIX = 'whitespace:1ct';

/** A little WBT the session key needs to pay its own gas, as a decimal string of ether. */
export const SESSION_KEY_GAS_TOPUP_WBT = '0.05';
/** Below this the session key is nearly out of gas and should be topped up before it stalls. */
export const SESSION_KEY_LOW_GAS_WEI = 5_000_000_000_000_000n; // 0.005 WBT

export function sessionKeyStorageKey(trader: Address, chainId: number = CHAIN_ID): string {
  return `${SESSION_KEY_STORAGE_PREFIX}:${chainId}:${trader.toLowerCase()}`;
}

/** A 0x-prefixed 32-byte hex string — the shape viem's privateKeyToAccount accepts. */
export function isValidPrivateKey(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

type MaybeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;

/**
 * Every component that trades reads the session key: the one-click toggle, the order ticket,
 * the close dialog, the position editors. Each used to keep its own copy, loaded once when
 * the wallet connected, so turning one-click on updated the toggle and nothing else — the
 * order ticket still held no key, saw `active === false`, and kept opening wallet pop-ups
 * until the page was reloaded. Writes now notify every subscriber, and a write in another
 * tab arrives through the `storage` event.
 */
const listeners = new Set<() => void>();

/** Keys this tab created while storage was unavailable; they last for the tab's lifetime. */
const memoryKeys = new Map<string, Hex>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key.startsWith(SESSION_KEY_STORAGE_PREFIX)) notify();
}

/** Subscribes to session-key changes in this tab and others. Returns the unsubscribe. */
export function subscribeSessionKeys(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function defaultStorage(): MaybeStorage {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The stored session private key for this trader, or null when there is none or storage is blocked. */
export function loadSessionPrivateKey(trader: Address, storage: MaybeStorage = defaultStorage()): Hex | null {
  const name = sessionKeyStorageKey(trader);
  try {
    const stored = storage?.getItem(name);
    if (isValidPrivateKey(stored)) return stored;
  } catch {
    // fall through to a key this tab holds in memory
  }
  return memoryKeys.get(name) ?? null;
}

function saveSessionPrivateKey(trader: Address, privateKey: Hex, storage: MaybeStorage = defaultStorage()): void {
  const name = sessionKeyStorageKey(trader);
  try {
    if (!storage) throw new Error('no storage');
    storage.setItem(name, privateKey);
    memoryKeys.delete(name);
  } catch {
    // No persistence available; the in-memory key still works for this tab's lifetime.
    memoryKeys.set(name, privateKey);
  }
  notify();
}

/** Wipes the trader's session key from storage. Called on revoke and on wallet disconnect. */
export function clearSessionKey(trader: Address, storage: MaybeStorage = defaultStorage()): void {
  const name = sessionKeyStorageKey(trader);
  memoryKeys.delete(name);
  try {
    storage?.removeItem(name);
  } catch {
    // Nothing to do — a storage that cannot delete also could not have persisted.
  }
  notify();
}

export interface SessionKey {
  privateKey: Hex;
  account: Account;
  address: Address;
}

function toSessionKey(privateKey: Hex): SessionKey {
  const account = privateKeyToAccount(privateKey);
  return { privateKey, account, address: account.address };
}

/** Loads the persisted session key for this trader, or null. */
export function getSessionKey(trader: Address, storage: MaybeStorage = defaultStorage()): SessionKey | null {
  const privateKey = loadSessionPrivateKey(trader, storage);
  return privateKey ? toSessionKey(privateKey) : null;
}

/** Generates a fresh session key for this trader, persists it, and returns it. */
export function createSessionKey(trader: Address, storage: MaybeStorage = defaultStorage()): SessionKey {
  const privateKey = generatePrivateKey();
  saveSessionPrivateKey(trader, privateKey, storage);
  return toSessionKey(privateKey);
}

/** A viem WalletClient bound to the session key that sends its own transactions over RPC. */
export function buildSessionWalletClient(account: Account): WalletClient {
  return createWalletClient({ account, chain: whitechainTestnet1874, transport: http(RPC_URL) });
}

/** ABI-encodes a Trading call so it can be carried inside delegatedAction. */
export function encodeTradingCall(functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: TRADING_ABI, functionName: functionName as never, args: args as never });
}

/**
 * The `[trader, calldata]` arguments for `delegatedAction`, wrapping an inner Trading call.
 * The contract runs the inner call with `_msgSender()` bound to `trader`.
 */
export function delegatedActionArgs(
  trader: Address,
  functionName: string,
  args: readonly unknown[],
): readonly [Address, Hex] {
  return [trader, encodeTradingCall(functionName, args)];
}
