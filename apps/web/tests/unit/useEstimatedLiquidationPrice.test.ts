import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEstimatedLiquidationPrice } from '@/hooks/useLiquidationPrice';

/** What the contract read returns on this render: `undefined` is a read still in flight. */
const read = vi.hoisted(() => ({ data: undefined as bigint | undefined }));

vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: read.data }),
}));

const E18 = 10n ** 18n;
const BASE = {
  openPriceRaw: 83_600n * E18,
  long: true,
  collateralRaw: 836_000000n,
  leverageRaw: 1000n,
  maxLeverageRaw: 10000n,
};
const LIQ = 75_450n * E18;

type Params = typeof BASE;

function mount() {
  read.data = LIQ;
  return renderHook((p: Params) => useEstimatedLiquidationPrice(p), { initialProps: BASE });
}

beforeEach(() => {
  read.data = undefined;
});

describe('useEstimatedLiquidationPrice', () => {
  it("returns the contract's answer", () => {
    const { result } = mount();
    expect(result.current).toBe(LIQ);
  });

  /**
   * The quote re-prices the entry every time the mark moves — every second or two — and
   * each new entry is a new read. Returning null until it lands blanked the ticket's
   * liquidation row and unmounted the risk preview on every tick.
   */
  it('keeps the last answer while the read for a moved price is in flight', () => {
    const { result, rerender } = mount();

    read.data = undefined;
    rerender({ ...BASE, openPriceRaw: BASE.openPriceRaw + 5n * E18 });
    expect(result.current).toBe(LIQ);

    read.data = LIQ + 4n * E18;
    rerender({ ...BASE, openPriceRaw: BASE.openPriceRaw + 5n * E18 });
    expect(result.current).toBe(LIQ + 4n * E18);
  });

  it('keeps it while the size is being edited', () => {
    const { result, rerender } = mount();
    read.data = undefined;
    rerender({ ...BASE, collateralRaw: 900_000000n });
    expect(result.current).toBe(LIQ);
  });

  it("does not carry a long's liquidation price over to a short", () => {
    const { result, rerender } = mount();
    read.data = undefined;
    rerender({ ...BASE, long: false });
    expect(result.current).toBeNull();
  });

  it('does not carry it across a leverage change, which moves it a long way', () => {
    const { result, rerender } = mount();
    read.data = undefined;
    rerender({ ...BASE, leverageRaw: 5000n });
    expect(result.current).toBeNull();
  });

  it('is null once the inputs are cleared, whatever it answered before', () => {
    const { result, rerender } = mount();
    // wagmi keeps the last result in its cache, so `data` can still hold an answer.
    rerender({ ...BASE, collateralRaw: 0n });
    expect(result.current).toBeNull();
  });

  it('has nothing to fall back on before its first answer', () => {
    const { result } = renderHook(() => useEstimatedLiquidationPrice(BASE));
    expect(result.current).toBeNull();
  });
});
