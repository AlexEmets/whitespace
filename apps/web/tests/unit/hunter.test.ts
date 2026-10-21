import { describe, expect, it } from 'vitest';
import { HUNTER_ADDRESS, HUNTER_CHAIN_ID, decodeHunterTokenUri, hunterExplorerUrl } from '@/lib/hunter';

/** Builds a tokenURI exactly as contracts/src/nft/Hunter.sol does: base64 JSON whose `image`
 *  is a base64 SVG data URI. */
function makeTokenUri(id: number) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg'><text>#${id}</text></svg>`;
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const json = JSON.stringify({
    name: `Hunter #${id}`,
    description: 'Whitespace bug-bounty reward.',
    image,
    attributes: [{ trait_type: 'Serial', value: id }],
  });
  return `data:application/json;base64,${Buffer.from(json).toString('base64')}`;
}

describe('Hunter deployment wiring', () => {
  it('pins badge reads to Whitechain mainnet 1875, not testnet 1874', () => {
    // The app trades on 1874, but the badges are a mainnet collection; useHunterNfts reads
    // against this chain id. If someone repoints lib/hunter.ts back to hunter-1874.json this
    // flips to 1874 and the badges silently read the wrong chain — so guard it here.
    expect(HUNTER_CHAIN_ID).toBe(1875);
  });

  it('links a badge to the contract page on the explorer', () => {
    // The Whitechain explorer has no per-instance page, so the "Explorer" button on each badge
    // points at the contract's address page — a route that always resolves.
    expect(hunterExplorerUrl()).toBe(`https://explorer.whitechain.io/address/${HUNTER_ADDRESS}`);
  });
});

describe('decodeHunterTokenUri', () => {
  it('decodes name, description and the embedded SVG image', () => {
    const meta = decodeHunterTokenUri(makeTokenUri(7));
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe('Hunter #7');
    expect(meta?.description).toBe('Whitespace bug-bounty reward.');
    expect(meta?.image.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('returns null when the prefix is not a JSON data URI', () => {
    expect(decodeHunterTokenUri('https://example.com/7.json')).toBeNull();
    expect(decodeHunterTokenUri('data:image/svg+xml;base64,AAAA')).toBeNull();
  });

  it('returns null for malformed base64 / JSON', () => {
    expect(decodeHunterTokenUri('data:application/json;base64,!!!not-base64!!!')).toBeNull();
    const notJson = `data:application/json;base64,${Buffer.from('nope').toString('base64')}`;
    expect(decodeHunterTokenUri(notJson)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const noImage = `data:application/json;base64,${Buffer.from(JSON.stringify({ name: 'x' })).toString('base64')}`;
    expect(decodeHunterTokenUri(noImage)).toBeNull();
    const noName = `data:application/json;base64,${Buffer.from(JSON.stringify({ image: 'x' })).toString('base64')}`;
    expect(decodeHunterTokenUri(noName)).toBeNull();
  });
});
