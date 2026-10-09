import { describe, expect, it } from 'vitest';
import {
  FULL_SHARE,
  closeSlippageBps,
  closeSizeForShare,
  leavesTooLittle,
  maxPartialShare,
  pnlForShare,
  shareForCloseSize,
} from '@/lib/closeTicket';

const E18 = 10n ** 18n;
const SIZE = 295n * E18 / 10_000n; // 0.0295 BTC

describe('closeSizeForShare', () => {
  it('is the position for a full close and a quarter of it for 25%', () => {
    expect(closeSizeForShare(SIZE, FULL_SHARE)).toBe(SIZE);
    expect(closeSizeForShare(SIZE, 2500)).toBe(SIZE / 4n);
  });
});

describe('shareForCloseSize', () => {
  it('turns a typed amount into the share the contract closes, at its 0.01% grain', () => {
    expect(shareForCloseSize(SIZE / 2n, SIZE)).toBe(5000);
    // 0.01 of 0.0295 = 33.898…% -> 33.90%
    expect(shareForCloseSize(E18 / 100n, SIZE)).toBe(3390);
  });

  it('closes all of it for the full size or more', () => {
    expect(shareForCloseSize(SIZE, SIZE)).toBe(FULL_SHARE);
    expect(shareForCloseSize(SIZE * 2n, SIZE)).toBe(FULL_SHARE);
  });

  it('never rounds a real amount down to nothing', () => {
    expect(shareForCloseSize(1n, SIZE)).toBe(1);
  });

  it('has no share for nothing, a negative amount, or an empty position', () => {
    expect(shareForCloseSize(0n, SIZE)).toBeNull();
    expect(shareForCloseSize(-1n, SIZE)).toBeNull();
    expect(shareForCloseSize(E18, 0n)).toBeNull();
  });
});

describe('leavesTooLittle', () => {
  // 100 USDW at 10x = 1,000 USDW notional; the market minimum is 500 USDW notional.
  const P = { collateralRaw: 100_000000n, leverageRaw: 1000n, minLevPosRaw: 500_000000n };

  it('allows a partial close that leaves at least the minimum', () => {
    expect(leavesTooLittle({ ...P, share: 5000 })).toBe(false);
  });

  it('refuses one that leaves less, as the contract does (BelowMinLevPos)', () => {
    expect(leavesTooLittle({ ...P, share: 5001 })).toBe(true);
  });

  it('never refuses a full close — nothing is left to be too small', () => {
    expect(leavesTooLittle({ ...P, share: FULL_SHARE })).toBe(false);
  });
});

describe('maxPartialShare', () => {
  it('is the largest share that still leaves the minimum', () => {
    expect(maxPartialShare({ collateralRaw: 100_000000n, leverageRaw: 1000n, minLevPosRaw: 500_000000n })).toBe(5000);
    expect(maxPartialShare({ collateralRaw: 100_000000n, leverageRaw: 1000n, minLevPosRaw: 1n })).toBe(9999);
  });

  it('is 0 when the position is already at the minimum, so only a full close is possible', () => {
    expect(maxPartialShare({ collateralRaw: 50_000000n, leverageRaw: 1000n, minLevPosRaw: 500_000000n })).toBe(0);
  });

  it('agrees with the contract check at the boundary it returns', () => {
    const p = { collateralRaw: 98_400000n, leverageRaw: 1000n, minLevPosRaw: 250_000000n };
    const max = maxPartialShare(p);
    expect(leavesTooLittle({ ...p, share: max })).toBe(false);
    expect(leavesTooLittle({ ...p, share: max + 1 })).toBe(true);
  });
});

describe('pnlForShare', () => {
  it('is that share of the unrealised PnL', () => {
    expect(pnlForShare(10_000000n, 2500)).toBe(2_500000n);
    expect(pnlForShare(-4_000000n, 5000)).toBe(-2_000000n);
  });
});

describe('closeSlippageBps', () => {
  const M = 100n * E18;
  const inputs = (bid: bigint, ask: bigint) => ({
    netVolThreshold: 0n,
    decayRate: 0n,
    priceImpactK: 0n,
    buyVolume: 0n,
    sellVolume: 0n,
    lastUpdateTimestamp: 0n,
    blockTimestamp: 0n,
    price: M,
    askPrice: ask,
    bidPrice: bid,
  });
  const LONG = { buy: true, collateralRaw: 1_000_000000n, leverageRaw: 1000n, share: FULL_SHARE };

  it('keeps the base tolerance when there is no quote', () => {
    expect(closeSlippageBps(null, LONG, 50n)).toBe(50n);
  });

  it('keeps the base tolerance when the closing side fills inside it', () => {
    expect(closeSlippageBps(inputs(M - M / 1000n, M + M / 1000n), LONG, 50n)).toBe(50n); // 0.1% half-spread
  });

  // A long closes by selling: at a bid 1% under the mark, 0.5% would cancel the close for
  // SLIPPAGE and charge the bond. The tolerance must cover the quoted fill.
  it('widens to cover a long close at the bid', () => {
    expect(closeSlippageBps(inputs(M - M / 100n, M), LONG, 50n)).toBe(101n);
  });

  it('quotes a short close on the ask side, not the bid', () => {
    const short = { ...LONG, buy: false };
    expect(closeSlippageBps(inputs(M - M / 100n, M + M / 50n), short, 50n)).toBe(201n);
    expect(closeSlippageBps(inputs(M - M / 100n, M), short, 50n)).toBe(50n);
  });
});
