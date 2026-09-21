import { market } from '../../ponder.schema.js';
import { bytes32ToSymbol } from './bytes32.js';
import { latestClient } from './latestClient.js';

// Same deliberate `any` as src/lib/db.ts: Ponder types `context.db` against the specific
// onchain tables via a branded template-literal type, so a helper that takes `db` as a
// parameter cannot be typed structurally without losing that per-table checking. The call
// site passes the real, correctly-typed objects.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;
type Contracts = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Set once every configured pair has a row, after which this costs nothing. Module-level,
// so it resets on restart and the check is re-run on every boot — which is what we want,
// since a dropped schema or a newly listed pair should re-seed without ceremony.
let seeded = false;

/**
 * Populate `market` from PairsStorage contract STATE rather than from `PairAdded` logs.
 *
 * Why this exists. `PairAdded` fired once, at block 7_284_583, and the public 1874
 * endpoint has pruned its log index: measured 2026-09-21 in 10_000-block windows (the
 * widest it accepts), there are zero logs anywhere at or below 7_900_000, but dozens at
 * 8_300_000 and above, while the old blocks themselves still return fine. So the listing
 * event is unreachable forever, from any startBlock, with any chunk size — and without it
 * `market` stays empty, which in turn empties /markets, /price and the index-candle
 * recorder in services/api, leaving the terminal with no market to select.
 *
 * Contract storage is NOT pruned, and `pairs(uint16)` already carries every column the
 * row needs — the PairAdded handler reads exactly the same view for exactly that reason.
 * So the pair list is reconstructed from current state, bounded by `pairsCount()`, and
 * the existing update events (PairMaxLeverageUpdated, PairFeedUpdated,
 * MaxOpenInterestUpdated) keep it current from here on. Future listings still arrive
 * through `PairAdded` normally; only the unreachable past needs this.
 *
 * Called from the block heartbeat so it runs regardless of contract activity, and guarded
 * so the chain is touched at most once per boot rather than every five blocks.
 */
export async function seedMarketsFromChain(
  db: Db,
  contracts: Contracts,
  block: { number: bigint; timestamp: bigint },
): Promise<void> {
  if (seeded) return;

  const { address, abi } = contracts.PairsStorage;

  let count: number;
  try {
    count = Number(await latestClient.readContract({ address, abi, functionName: 'pairsCount' }));
  } catch (error) {
    // Leave `seeded` false so the next heartbeat retries: a rate-limited or flaky RPC read
    // must not permanently disable seeding for the life of the process.
    console.warn('[indexer] seedMarkets: pairsCount read failed, will retry —', (error as Error).message);
    return;
  }

  for (let pairIndex = 0; pairIndex < count; pairIndex++) {
    if ((await db.find(market, { pairIndex })) != null) continue;

    try {
      const [from, to, feed, , , maxLeverage, groupIndex, feeIndex, oracle] = (await latestClient.readContract({
        address,
        abi,
        functionName: 'pairs',
        args: [pairIndex],
      })) as [`0x${string}`, `0x${string}`, `0x${string}`, bigint, number, number, number, number, string];

      const fromSymbol = bytes32ToSymbol(from);
      const toSymbol = bytes32ToSymbol(to);

      await db
        .insert(market)
        .values({
          pairIndex,
          fromSymbol,
          toSymbol,
          feedId: feed,
          oracle,
          groupIndex,
          feeIndex,
          maxLeverage,
          // Seeded at zero exactly as the PairAdded handler does; MaxOpenInterestUpdated
          // and the open-interest deltas accumulated from trade events own these.
          maxOpenInterest: 0n,
          openInterestLong: 0n,
          openInterestShort: 0n,
          updatedAtBlock: block.number,
          updatedAt: Number(block.timestamp),
        })
        .onConflictDoUpdate({
          fromSymbol,
          toSymbol,
          feedId: feed,
          groupIndex,
          feeIndex,
          maxLeverage,
          updatedAtBlock: block.number,
          updatedAt: Number(block.timestamp),
        });

      console.log(
        `[indexer] seedMarkets: seeded pair ${pairIndex} ${fromSymbol}/${toSymbol} from contract state ` +
          `(maxLeverage=${maxLeverage}) — PairAdded is in the pruned log range`,
      );
    } catch (error) {
      console.warn(`[indexer] seedMarkets: pairs(${pairIndex}) read failed, will retry —`, (error as Error).message);
      return;
    }
  }

  seeded = true;
}
