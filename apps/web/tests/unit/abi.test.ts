import { describe, expect, it } from 'vitest';
import { CANCEL_REASONS, explainCancelReason } from '@/lib/abi';

describe('CANCEL_REASONS', () => {
  it('matches IOstiumTradingCallbacks.CancelReason exactly (16 entries, NONE first)', () => {
    // Transcribed from contracts/src/vendor/ostium/interfaces/IOstiumTradingCallbacks.sol.
    expect(CANCEL_REASONS).toEqual([
      'NONE',
      'PAUSED',
      'MARKET_CLOSED',
      'SLIPPAGE',
      'TP_REACHED',
      'SL_REACHED',
      'EXPOSURE_LIMITS',
      'PRICE_IMPACT',
      'MAX_LEVERAGE',
      'NO_TRADE',
      'UNDER_LIQUIDATION',
      'NOT_HIT',
      'GAIN_LOSS',
      'DAY_TRADE_NOT_ALLOWED',
      'CLOSE_DAY_TRADE_NOT_ALLOWED',
      'WRONG_TRADE',
    ]);
  });
});

describe('explainCancelReason', () => {
  it('explains SLIPPAGE with the refund detail (collateral minus oracle fee)', () => {
    expect(explainCancelReason('SLIPPAGE')).toMatch(/refund/i);
    expect(explainCancelReason('SLIPPAGE')).toMatch(/oracle fee/i);
  });

  it('falls back to a generic-but-honest explanation for an unmapped reason', () => {
    expect(explainCancelReason('SOME_FUTURE_REASON')).toMatch(/refund/i);
  });
});
