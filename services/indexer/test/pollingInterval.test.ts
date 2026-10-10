import { describe, it, expect } from 'vitest';
import { parseGetLogsBlockRange, parsePollingInterval } from '../src/lib/pollingInterval.js';

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

describe('parseGetLogsBlockRange', () => {
  it('defaults under the public RPC\'s 10,000-block limit', () => {
    expect(parseGetLogsBlockRange(undefined)).toBe(9000);
    expect(parseGetLogsBlockRange('')).toBe(9000);
  });
  it('accepts 1..10000', () => {
    expect(parseGetLogsBlockRange('1')).toBe(1);
    expect(parseGetLogsBlockRange('10000')).toBe(10000);
  });
  it('refuses anything the RPC would reject or that is not a whole number', () => {
    for (const bad of ['0', '10001', '-5', '2.5', 'many']) {
      expect(() => parseGetLogsBlockRange(bad)).toThrow(/PONDER_GETLOGS_BLOCK_RANGE/);
    }
  });
});
