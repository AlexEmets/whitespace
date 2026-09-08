import { defineConfig } from 'vitest/config';

// Deliberately does NOT boot Ponder's dev server or touch `ponder:registry`
// / `ponder:schema` virtual modules — those only exist inside Ponder's own
// Vite-based runtime. Everything under test/ imports plain TS modules
// (abis/*.ts, src/lib/*.ts, ponder.schema.ts's real exports), so a plain
// vitest run is enough; no live RPC, no live Postgres, no `ponder dev`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
