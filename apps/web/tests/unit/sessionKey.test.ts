import { decodeFunctionData, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { TRADING_ABI } from '@/lib/abi';
import { CHAIN_ID } from '@/lib/config';
import {
  clearSessionKey,
  createSessionKey,
  delegatedActionArgs,
  encodeTradingCall,
  getSessionKey,
  isValidPrivateKey,
  loadSessionPrivateKey,
  sessionKeyStorageKey,
} from '@/lib/sessionKey';

const TRADER = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;

/** A deterministic in-memory Storage stand-in, so tests never touch the shared jsdom store. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

/** A Storage that throws on every access — a private window or a blocked origin. */
const blockedStorage = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
  removeItem() {
    throw new Error('blocked');
  },
};

let storage: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  storage = fakeStorage();
});

describe('sessionKeyStorageKey', () => {
  it('namespaces by prefix, chain and lowercased trader', () => {
    expect(sessionKeyStorageKey('0xABCdef0000000000000000000000000000000000')).toBe(
      `whitespace:1ct:${CHAIN_ID}:0xabcdef0000000000000000000000000000000000`,
    );
  });
});

describe('isValidPrivateKey', () => {
  it('accepts a 0x-prefixed 32-byte hex and rejects anything else', () => {
    expect(isValidPrivateKey(`0x${'a'.repeat(64)}`)).toBe(true);
    expect(isValidPrivateKey(`0x${'a'.repeat(63)}`)).toBe(false);
    expect(isValidPrivateKey('0xnothex')).toBe(false);
    expect(isValidPrivateKey(null)).toBe(false);
    expect(isValidPrivateKey(123)).toBe(false);
  });
});

describe('create / get / clear', () => {
  it('creates a key, persists it, and reads back the same account', () => {
    const created = createSessionKey(TRADER, storage);
    expect(isValidPrivateKey(created.privateKey)).toBe(true);
    expect(created.address).toBe(privateKeyToAccount(created.privateKey).address);

    const loaded = getSessionKey(TRADER, storage);
    expect(loaded?.privateKey).toBe(created.privateKey);
    expect(loaded?.address).toBe(created.address);
  });

  it('scopes the key to the trader — a different wallet has no key', () => {
    createSessionKey(TRADER, storage);
    expect(getSessionKey(OTHER, storage)).toBeNull();
  });

  it('generates a distinct key per trader', () => {
    const a = createSessionKey(TRADER, storage);
    const b = createSessionKey(OTHER, storage);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.address).not.toBe(b.address);
  });

  it('clear removes the key so it no longer loads', () => {
    createSessionKey(TRADER, storage);
    clearSessionKey(TRADER, storage);
    expect(getSessionKey(TRADER, storage)).toBeNull();
    expect(loadSessionPrivateKey(TRADER, storage)).toBeNull();
  });

  it('ignores a corrupt stored value instead of handing back garbage', () => {
    storage.setItem(sessionKeyStorageKey(TRADER), 'not-a-key');
    expect(getSessionKey(TRADER, storage)).toBeNull();
  });

  it('degrades to no session when storage is blocked, never throwing', () => {
    expect(() => createSessionKey(TRADER, blockedStorage)).not.toThrow();
    expect(loadSessionPrivateKey(TRADER, blockedStorage)).toBeNull();
    expect(() => clearSessionKey(TRADER, blockedStorage)).not.toThrow();
  });
});

describe('encodeTradingCall / delegatedActionArgs', () => {
  it('encodes a Trading call identically to viem and round-trips through decode', () => {
    const args = [0, 1, 70_000n * 10n ** 18n] as const;
    const encoded = encodeTradingCall('updateTp', args);
    expect(encoded).toBe(encodeFunctionData({ abi: TRADING_ABI, functionName: 'updateTp', args }));

    const decoded = decodeFunctionData({ abi: TRADING_ABI, data: encoded });
    expect(decoded.functionName).toBe('updateTp');
    expect(decoded.args).toEqual(args);
  });

  it('wraps the inner call as [trader, calldata] for delegatedAction', () => {
    const args = [0, 1] as const;
    const [trader, calldata] = delegatedActionArgs(TRADER, 'cancelOpenLimitOrder', args);
    expect(trader).toBe(TRADER);
    expect(calldata).toBe(encodeTradingCall('cancelOpenLimitOrder', args));
    expect(decodeFunctionData({ abi: TRADING_ABI, data: calldata }).functionName).toBe('cancelOpenLimitOrder');
  });
});
