import { describe, it, expect } from 'vitest';
import { parsePollingInterval } from '../src/lib/pollingInterval.js';

describe('parsePollingInterval', () => {
  it('defaults to 2000 ms, half the load of Ponder\'s own 1 s default', () => {
    expect(parsePollingInterval(undefined)).toBe(2000);
    expect(parsePollingInterval('')).toBe(2000);
  });
  it('accepts an integer at or above 500', () => {
    expect(parsePollingInterval('500')).toBe(500);
    expect(parsePollingInterval('3000')).toBe(3000);
  });
  it('refuses a value that would hammer the RPC or is not a number', () => {
    for (const bad of ['499', '0', '-1', '1.5', 'abc']) {
      expect(() => parsePollingInterval(bad)).toThrow(/PONDER_POLLING_INTERVAL_MS/);
    }
  });
});
