import { describe, expect, it } from 'vitest';
import { computeTicket, convertSizeInput, percentOfBalance, sizeForPercentOfBalance, type TicketInput } from '@/lib/orderTicket';

const E18 = 10n ** 18n;
const base: TicketInput = {
  unit: 'BASE',
  sizeInput: '',
  leverageRaw: 1_000n, // 10x
  entryPrice: 100_000n * E18,
  takerFeeRaw: 60_000n, // 0.06%
  oracleFeeRaw: 1_000_000n, // $1
};

describe('computeTicket', () => {
  it('an empty field is a zero ticket with no fee, not an error', () => {
    expect(computeTicket(base)).toEqual({ sizeBaseRaw: 0n, notionalRaw: 0n, collateralRaw: 0n, feeRaw: 0n });
  });

  it('base units: 0.1 BTC at 100k and 10x is 10,000 notional on 1,000 margin', () => {
    const t = computeTicket({ ...base, sizeInput: '0.1' })!;
    expect(t.sizeBaseRaw).toBe(E18 / 10n);
    expect(t.notionalRaw).toBe(10_000_000_000n);
    expect(t.collateralRaw).toBe(1_000_000_000n);
    // 10,000 * 0.06% = 6, plus the $1 oracle fee
    expect(t.feeRaw).toBe(7_000_000n);
  });

  it('USD units: 10,000 notional is the same ticket', () => {
    const t = computeTicket({ ...base, unit: 'USD', sizeInput: '10000' })!;
    expect(t.notionalRaw).toBe(10_000_000_000n);
    expect(t.collateralRaw).toBe(1_000_000_000n);
    expect(t.sizeBaseRaw).toBe(E18 / 10n);
  });

  it('margin floors, never rounding up past what the size costs', () => {
    const t = computeTicket({ ...base, unit: 'USD', sizeInput: '0.000001', leverageRaw: 300n })!;
    expect(t.collateralRaw).toBe(0n); // 1 raw * 100 / 300 floors to 0
  });

  it('an unknown fee rate yields a null fee rather than a guessed one', () => {
    expect(computeTicket({ ...base, sizeInput: '1', takerFeeRaw: null })!.feeRaw).toBeNull();
    expect(computeTicket({ ...base, sizeInput: '1', oracleFeeRaw: null })!.feeRaw).toBeNull();
  });

  it('rejects text that is not a decimal', () => {
    expect(computeTicket({ ...base, sizeInput: 'abc' })).toBeNull();
    expect(computeTicket({ ...base, sizeInput: '-1' })).toBeNull();
  });

  it('with no entry price yet a base size has no notional or margin', () => {
    const t = computeTicket({ ...base, sizeInput: '1', entryPrice: 0n })!;
    expect(t.notionalRaw).toBe(0n);
    expect(t.collateralRaw).toBe(0n);
  });
});

describe('sizeForPercentOfBalance', () => {
  const p = { balanceRaw: 1_000_000_000n, leverageRaw: 1_000n, entryPrice: 100_000n * E18 };
  it('100% of 1,000 USDW at 10x is 0.1 BTC / 10,000 USD', () => {
    expect(sizeForPercentOfBalance({ ...p, percent: 100, unit: 'BASE' })).toBe('0.100000');
    expect(sizeForPercentOfBalance({ ...p, percent: 100, unit: 'USD' })).toBe('10000.00');
  });
  it('clamps above 100 and empties at zero or with no balance', () => {
    expect(sizeForPercentOfBalance({ ...p, percent: 150, unit: 'USD' })).toBe('10000.00');
    expect(sizeForPercentOfBalance({ ...p, percent: 0, unit: 'USD' })).toBe('');
    expect(sizeForPercentOfBalance({ ...p, balanceRaw: 0n, percent: 50, unit: 'USD' })).toBe('');
  });
  it('round-trips: the chosen percent never needs more margin than the balance', () => {
    for (const percent of [1, 25, 33, 50, 75, 99, 100]) {
      const sizeInput = sizeForPercentOfBalance({ ...p, percent, unit: 'BASE' });
      const t = computeTicket({ ...base, sizeInput })!;
      expect(t.collateralRaw <= p.balanceRaw).toBe(true);
    }
  });
});

describe('convertSizeInput', () => {
  it('toggles between base and USD for the same order', () => {
    expect(convertSizeInput({ ...base, sizeInput: '0.1' }, 'USD')).toBe('10000.00');
    expect(convertSizeInput({ ...base, unit: 'USD', sizeInput: '10000' }, 'BASE')).toBe('0.100000');
    expect(convertSizeInput({ ...base, sizeInput: '0.1' }, 'BASE')).toBe('0.1');
    expect(convertSizeInput({ ...base, sizeInput: '' }, 'USD')).toBe('');
  });
});

describe('percentOfBalance', () => {
  it('is two-decimal exact and zero without a balance', () => {
    expect(percentOfBalance(250_000_000n, 1_000_000_000n)).toBe(25);
    expect(percentOfBalance(1n, 3n)).toBe(33.33);
    expect(percentOfBalance(1n, 0n)).toBe(0);
  });
});
