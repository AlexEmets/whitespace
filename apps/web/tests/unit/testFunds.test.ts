import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  LOW_GAS_WEI,
  formatWbt,
  fundingNeeds,
  getStartedSeenKey,
  hasSeenGetStarted,
  markGetStartedSeen,
  needsFunding,
} from '@/lib/testFunds';

const OWNER = '0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B';
const OTHER = '0x2222222222222222222222222222222222222222';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('fundingNeeds', () => {
  it('says nothing until both balances have been read', () => {
    expect(fundingNeeds(null, 0n)).toBeNull();
    expect(fundingNeeds(0n, null)).toBeNull();
    expect(fundingNeeds(null, null)).toBeNull();
    expect(needsFunding(null)).toBe(false);
  });

  it('flags a brand-new wallet as short of both gas and margin', () => {
    const needs = fundingNeeds(0n, 0n);
    expect(needs).toEqual({ gas: true, collateral: true });
    expect(needsFunding(needs)).toBe(true);
  });

  it('counts gas as short up to one wei under the threshold, and enough at it', () => {
    expect(fundingNeeds(LOW_GAS_WEI - 1n, 1n)?.gas).toBe(true);
    expect(fundingNeeds(LOW_GAS_WEI, 1n)?.gas).toBe(false);
  });

  it('counts margin as missing only when the wallet holds no USDW at all', () => {
    expect(fundingNeeds(LOW_GAS_WEI, 0n)?.collateral).toBe(true);
    expect(fundingNeeds(LOW_GAS_WEI, 1n)?.collateral).toBe(false);
  });

  it('needs nothing from a wallet with gas and margin', () => {
    expect(needsFunding(fundingNeeds(parseEther('0.3'), 1_000_000_000n))).toBe(false);
  });

  it('needs funding when only one of the two is short', () => {
    expect(needsFunding(fundingNeeds(0n, 1_000_000_000n))).toBe(true);
    expect(needsFunding(fundingNeeds(parseEther('0.3'), 0n))).toBe(true);
  });
});

describe('formatWbt', () => {
  it('shows four places, rounded down', () => {
    expect(formatWbt(0n)).toBe('0.0000');
    expect(formatWbt(parseEther('0.3'))).toBe('0.3000');
    expect(formatWbt(parseEther('0.00019'))).toBe('0.0001');
    expect(formatWbt(1n)).toBe('0.0000');
  });

  it('groups whole WBT by thousands', () => {
    expect(formatWbt(parseEther('1234.56789'))).toBe('1,234.5678');
  });
});

describe('first-connect memory', () => {
  it('has not offered setup to a wallet it has never seen', () => {
    expect(hasSeenGetStarted(OWNER, memoryStorage())).toBe(false);
  });

  it('remembers an address once marked, whatever its letter case', () => {
    const storage = memoryStorage();
    markGetStartedSeen(OWNER, storage);
    expect(hasSeenGetStarted(OWNER, storage)).toBe(true);
    expect(hasSeenGetStarted(OWNER.toLowerCase() as `0x${string}`, storage)).toBe(true);
  });

  it('keeps each address separate', () => {
    const storage = memoryStorage();
    markGetStartedSeen(OWNER, storage);
    expect(hasSeenGetStarted(OTHER, storage)).toBe(false);
  });

  it('scopes the key to the chain, so a redeploy elsewhere asks again', () => {
    expect(getStartedSeenKey(OWNER, 1874)).not.toBe(getStartedSeenKey(OWNER, 1875));
    expect(getStartedSeenKey(OWNER, 1874)).toBe(`whitespace:get-started:1874:${OWNER.toLowerCase()}`);
  });

  it('treats storage that throws as never seen, and marking it as a no-op', () => {
    expect(() => markGetStartedSeen(OWNER, throwingStorage)).not.toThrow();
    expect(hasSeenGetStarted(OWNER, throwingStorage)).toBe(false);
  });
});
