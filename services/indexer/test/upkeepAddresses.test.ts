import { describe, expect, it } from 'vitest';
import { priceUpKeepAddresses } from '../src/lib/upkeepAddresses.js';

describe('priceUpKeepAddresses', () => {
  it('is just the current upkeep when nothing was replaced', () => {
    expect(priceUpKeepAddresses({ priceUpKeep: '0xAA' })).toEqual(['0xAA']);
  });

  it('adds every replaced upkeep after the current one, once each', () => {
    expect(priceUpKeepAddresses({ priceUpKeep: '0xAA', previousPriceUpKeeps: ['0xbb', '0xBB', '0xaa', '0xCC'] })).toEqual([
      '0xAA',
      '0xbb',
      '0xCC',
    ]);
  });
});
