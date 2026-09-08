// Small write-side helper: Ponder's `db.update`/`db.delete` throw if the
// target row doesn't exist. Most of the time that's the right behavior (a
// bug should be loud), but a handful of handlers here react to an event
// whose corresponding row *should* already exist (created by an earlier
// event) but isn't guaranteed to for edge cases outside this indexer's
// control — e.g. a close/cancel/timeout event whose matching open event
// landed before `startBlock`. In those specific spots we skip and log
// instead of crashing the whole indexer over one row.
// Ponder's real `context.db` types `.find`/`.update`/`.delete` against the
// specific onchain tables declared in ponder.schema.ts (via a branded
// template-literal type), so a table-agnostic helper like this one can't be
// typed against it structurally without losing that per-table checking
// anyway — every call site below already passes a concrete, correctly
// -typed `table` object and gets its return value cast by the caller.
// `db: any` here is deliberate, not a shortcut: verified end to end by
// actually running `ponder start` against live Whitechain testnet 1874 data
// (see docs/decisions/phase-4-indexer-api.md) rather than only relying on
// this file's own type-checking.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function updateIfExists(
  db: Db,
  table: unknown,
  key: Record<string, unknown>,
  patch: unknown,
  context: string,
): Promise<void> {
  const existing = await db.find(table, key);
  if (existing == null) {
    console.warn(`[indexer] ${context}: no existing row for key`, key, '— skipping update');
    return;
  }
  await db.update(table, key).set(patch as never);
}

export async function findOrWarn<T>(
  db: Db,
  table: unknown,
  key: Record<string, unknown>,
  context: string,
): Promise<T | null> {
  const existing = (await db.find(table, key)) as T | null;
  if (existing == null) {
    console.warn(`[indexer] ${context}: no existing row for key`, key, '— skipping');
  }
  return existing;
}
