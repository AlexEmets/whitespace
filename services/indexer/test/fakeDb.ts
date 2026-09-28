// An in-memory stand-in for Ponder's `context.db` store API, covering exactly the surface
// the handler logic in src/lib uses: find / insert().values() [.onConflictDoUpdate /
// .onConflictDoNothing] / update().set() / delete().
//
// It keys rows by each table's real primary key, read off the Drizzle column objects that
// ponder.schema.ts exports (`column.primary`), so a test cannot pass by keying a row on
// something the real store would not. Semantics mirror Ponder's where they matter:
//   - a bare `insert().values()` on an existing key throws (a duplicate is a bug),
//   - `update()` on a missing row throws,
//   - `set()` / `onConflictDoUpdate()` accept a patch object or a (row) => patch function,
//   - `delete()` returns whether a row was removed.

type Row = Record<string, unknown>;
type Patch = Row | ((row: Row) => Row);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Table = any;

function pkColumns(table: Table): string[] {
  const cols = Object.keys(table).filter((k) => table[k] && typeof table[k] === 'object' && table[k].primary === true);
  if (cols.length === 0) throw new Error('fakeDb: table has no primary key column');
  return cols;
}

function keyOf(table: Table, row: Row): string {
  return JSON.stringify(pkColumns(table).map((c) => String(row[c])));
}

export type FakeDb = ReturnType<typeof makeFakeDb>;

export function makeFakeDb() {
  const tables = new Map<Table, Map<string, Row>>();
  const store = (table: Table) => {
    let m = tables.get(table);
    if (!m) {
      m = new Map();
      tables.set(table, m);
    }
    return m;
  };
  const apply = (row: Row, patch: Patch): Row => ({ ...row, ...(typeof patch === 'function' ? patch(row) : patch) });

  const db = {
    async find(table: Table, key: Row): Promise<Row | null> {
      return store(table).get(keyOf(table, key)) ?? null;
    },
    insert(table: Table) {
      return {
        values(row: Row) {
          const k = keyOf(table, row);
          // The plain insert runs only when the builder itself is awaited, so a chained
          // onConflict* call replaces it rather than racing it.
          const plain = async () => {
            if (store(table).has(k)) throw new Error(`fakeDb: duplicate key ${k}`);
            store(table).set(k, { ...row });
          };
          return {
            then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
              return plain().then(resolve, reject);
            },
            async onConflictDoUpdate(patch: Patch) {
              const existing = store(table).get(k);
              store(table).set(k, existing ? apply(existing, patch) : { ...row });
            },
            async onConflictDoNothing() {
              if (!store(table).has(k)) store(table).set(k, { ...row });
            },
          };
        },
      };
    },
    update(table: Table, key: Row) {
      return {
        async set(patch: Patch) {
          const k = keyOf(table, key);
          const existing = store(table).get(k);
          if (!existing) throw new Error(`fakeDb: update of missing row ${k}`);
          store(table).set(k, apply(existing, patch));
        },
      };
    },
    async delete(table: Table, key: Row): Promise<boolean> {
      return store(table).delete(keyOf(table, key));
    },
  };

  return {
    db,
    rows(table: Table): Row[] {
      return [...store(table).values()];
    },
    get(table: Table, key: Row): Row | undefined {
      return store(table).get(keyOf(table, key));
    },
    seed(table: Table, row: Row): void {
      store(table).set(keyOf(table, row), { ...row });
    },
  };
}
