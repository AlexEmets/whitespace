import { describe, expect, it, vi } from 'vitest';
import { GAS_HEADROOM_PERCENT, padGas, withHeadroom } from '@/lib/gas';

describe('withHeadroom', () => {
  it('adds 30%, rounding up so the pad is never short', () => {
    expect(GAS_HEADROOM_PERCENT).toBe(30n);
    expect(withHeadroom(100_000n)).toBe(130_000n);
    expect(withHeadroom(1n)).toBe(2n);
    expect(withHeadroom(0n)).toBe(0n);
  });

  it('covers the ~2.9k gas a next-block timestamp rewrite costs over its estimate', () => {
    const estimate = 45_000n;
    expect(withHeadroom(estimate) - estimate >= 2_900n).toBe(true);
  });
});

describe('padGas', () => {
  it('estimates the exact request and returns it with the padded limit', async () => {
    const estimateContractGas = vi.fn(async () => 200_000n);
    const request = { address: '0x1' as const, abi: [], functionName: 'updateTp', args: [0, 0, 1n] };
    const padded = await padGas({ estimateContractGas } as never, request as never);
    expect(estimateContractGas).toHaveBeenCalledWith(request);
    expect(padded).toEqual({ ...request, gas: 260_000n });
  });

  it('propagates an estimation revert instead of sending blind', async () => {
    const estimateContractGas = vi.fn(async () => {
      throw new Error('execution reverted: WrongTP()');
    });
    await expect(padGas({ estimateContractGas } as never, {} as never)).rejects.toThrow(/WrongTP/);
  });
});
