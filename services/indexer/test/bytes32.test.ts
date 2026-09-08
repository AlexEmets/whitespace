// Regression test for a real bug caught by live-syncing against Whitechain
// testnet 1874: `ponder start` logged "Detected and removed null byte
// characters ... table=market column=from_symbol" because the original
// implementation left literal NUL characters in the decoded string — see
// src/lib/bytes32.ts for the full story.
import { describe, it, expect } from 'vitest';
import { bytes32ToSymbol } from '../src/lib/bytes32.js';

describe('bytes32ToSymbol', () => {
  it('strips the NUL padding from a real on-chain bytes32("BTC")', () => {
    const raw = '0x4254430000000000000000000000000000000000000000000000000000000000' as const;
    const decoded = bytes32ToSymbol(raw);
    expect(decoded).toBe('BTC');
    expect(decoded).not.toMatch(/\u0000/);
    expect(decoded.length).toBe(3);
  });

  it('strips the NUL padding from bytes32("USD")', () => {
    const raw = '0x5553440000000000000000000000000000000000000000000000000000000000' as const;
    expect(bytes32ToSymbol(raw)).toBe('USD');
  });

  it('a fully-padded (empty) bytes32 decodes to an empty string, not 32 NULs', () => {
    const raw = `0x${'00'.repeat(32)}` as const;
    expect(bytes32ToSymbol(raw)).toBe('');
  });

  it('does not strip meaningful non-NUL characters, only the padding', () => {
    // bytes32("BTC/USD") - a longer, still short-of-32-bytes symbol
    const raw = '0x4254432f55534400000000000000000000000000000000000000000000000000' as const;
    expect(bytes32ToSymbol(raw)).toBe('BTC/USD');
  });
});
