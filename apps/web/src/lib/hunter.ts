import { parseAbi, zeroAddress, type Address } from 'viem';
import hunterDeployment from '../../../../deployments/hunter-1875.json' assert { type: 'json' };

/**
 * The Hunter bug-bounty NFT collection (contracts/src/nft/Hunter.sol) on Whitechain **mainnet
 * 1875**. The rest of the app trades on testnet 1874, but the badges are a mainnet collection,
 * so address and chain both come from `deployments/hunter-1875.json` — one file to update on a
 * redeploy. {HUNTER_CHAIN_ID} is what useHunterNfts pins its reads to, so a wallet connected to
 * testnet still sees its mainnet badges.
 *
 * A zero address means "not deployed yet": {HUNTER_DEPLOYED} is false and the points page
 * hides its badges section, so the app builds and runs before the collection exists.
 */
export const HUNTER_ADDRESS = hunterDeployment.address as Address;
export const HUNTER_CHAIN_ID = hunterDeployment.chainId as 1875;
export const HUNTER_DEPLOYED = HUNTER_ADDRESS.toLowerCase() !== zeroAddress;

/**
 * Block explorer for the Hunter collection's chain (mainnet 1875). Overridable with
 * NEXT_PUBLIC_HUNTER_EXPLORER; the trailing slash is trimmed so paths join cleanly.
 */
export const HUNTER_EXPLORER = (
  process.env.NEXT_PUBLIC_HUNTER_EXPLORER ?? 'https://explorer.whitechain.io'
).replace(/\/+$/, '');

/**
 * Link to the Hunter collection on the explorer. The Whitechain mainnet explorer has no
 * per-token-instance page — its only token route is `/token/<addr>`, which 404s for a token it
 * has not indexed — so every badge links to the contract's address page, a route that always
 * resolves and carries the collection's token transfers and holders. (The badge art itself
 * already shows which serial it is.)
 */
export function hunterExplorerUrl(): string {
  return `${HUNTER_EXPLORER}/address/${HUNTER_ADDRESS}`;
}

// Only the read surface the UI needs, transcribed from contracts/src/nft/Hunter.sol and the
// ERC721Enumerable it mixes in. `tokenOfOwnerByIndex` is what lets the frontend list a
// wallet's badges straight from chain, with no indexer.
export const HUNTER_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
]);

export type HunterMetadata = { name: string; image: string; description?: string };

/**
 * Decodes a Hunter `tokenURI` — `data:application/json;base64,<json>` whose `image` is itself
 * a `data:image/svg+xml;base64,<svg>` URI usable directly as an `<img src>`. Returns null for
 * anything that is not a well-formed Hunter metadata URI, so a bad read is skipped, never
 * rendered. `atob` in the browser, `Buffer` under Node (tests/SSR).
 */
export function decodeHunterTokenUri(uri: string): HunterMetadata | null {
  const prefix = 'data:application/json;base64,';
  if (!uri.startsWith(prefix)) return null;
  const b64 = uri.slice(prefix.length);
  try {
    const json =
      typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf8');
    const meta = JSON.parse(json) as Record<string, unknown>;
    if (typeof meta.name !== 'string' || typeof meta.image !== 'string') return null;
    return {
      name: meta.name,
      image: meta.image,
      description: typeof meta.description === 'string' ? meta.description : undefined,
    };
  } catch {
    return null;
  }
}
