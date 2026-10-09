/**
 * Every price upkeep the indexer must read: the current one and any it replaced.
 *
 * Requests and reports are emitted by whichever upkeep the registry pointed at at the time.
 * After an upgrade (Operate.s.sol `installHardenedUpkeep` replacing an outdated build) a fresh
 * index built from the current address alone would lose every earlier request and report,
 * and with them the price candles. deployments/<chain>.json names the old ones in
 * `contracts.previousPriceUpKeeps` (tools/deploy/manifest.mjs).
 */
export function priceUpKeepAddresses(contracts: { priceUpKeep: string; previousPriceUpKeeps?: string[] }): `0x${string}`[] {
  const all = [contracts.priceUpKeep, ...(contracts.previousPriceUpKeeps ?? [])];
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const a of all) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a as `0x${string}`);
  }
  return out;
}
