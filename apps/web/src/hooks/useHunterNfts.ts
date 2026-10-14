'use client';

import { useReadContract, useReadContracts } from 'wagmi';
import {
  HUNTER_ABI,
  HUNTER_ADDRESS,
  HUNTER_DEPLOYED,
  decodeHunterTokenUri,
  type HunterMetadata,
} from '@/lib/hunter';

export type HunterBadge = { tokenId: bigint } & HunterMetadata;

/**
 * A wallet's Hunter badges, read straight from the chain (no indexer): `balanceOf`, then one
 * `tokenOfOwnerByIndex` per badge (ERC721Enumerable), then `tokenURI` per id, decoded to its
 * on-chain name + SVG image. Also returns the collection's minted/cap for a progress line.
 *
 * Disabled — and returns empty — until the collection is deployed (HUNTER_DEPLOYED) and a
 * wallet is connected, so the points page renders fine before Hunter exists.
 */
export function useHunterNfts(address?: `0x${string}`) {
  const enabled = Boolean(address) && HUNTER_DEPLOYED;

  const balanceQ = useReadContract({
    address: HUNTER_ADDRESS,
    abi: HUNTER_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled, refetchInterval: 30_000 },
  });
  const count = Number((balanceQ.data as bigint | undefined) ?? 0n);

  const idsQ = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: HUNTER_ADDRESS,
      abi: HUNTER_ABI,
      functionName: 'tokenOfOwnerByIndex' as const,
      args: [address as `0x${string}`, BigInt(i)] as const,
    })),
    query: { enabled: enabled && count > 0 },
  });
  const tokenIds = (idsQ.data ?? []).flatMap((r) => (r.status === 'success' ? [r.result as bigint] : []));

  const uriQ = useReadContracts({
    contracts: tokenIds.map((id) => ({
      address: HUNTER_ADDRESS,
      abi: HUNTER_ABI,
      functionName: 'tokenURI' as const,
      args: [id] as const,
    })),
    query: { enabled: enabled && tokenIds.length > 0 },
  });

  const badges: HunterBadge[] = [];
  tokenIds.forEach((id, i) => {
    const r = uriQ.data?.[i];
    if (!r || r.status !== 'success') return;
    const meta = decodeHunterTokenUri(r.result as string);
    if (meta) badges.push({ tokenId: id, ...meta });
  });
  badges.sort((a, b) => (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0));

  return {
    badges,
    count,
    deployed: HUNTER_DEPLOYED,
    loading: balanceQ.isLoading || idsQ.isLoading || uriQ.isLoading,
  };
}
