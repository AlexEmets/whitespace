import { hexToString } from 'viem';

/**
 * Decode a Solidity bytes32 string literal (right-padded with NUL bytes) to
 * a plain JS string. viem's `hexToString` does NOT stop at the first NUL —
 * it decodes every byte, padding included, into literal U+0000 characters,
 * which Postgres "text" columns reject outright. Confirmed live against
 * Whitechain testnet 1874: without stripping these, `ponder start` logged
 * "Detected and removed null byte characters ... table=market
 * column=from_symbol" — Ponder was silently sanitizing the bad input for us.
 * This strips them explicitly instead of depending on that fallback.
 */
export function bytes32ToSymbol(hex: `0x${string}`): string {
  return hexToString(hex).replace(/[\u0000]/g, '');
}
