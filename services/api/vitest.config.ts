import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // All test files share ONE ephemeral Postgres instance and truncate
    // tables between tests — running files in parallel would let them
    // stomp on each other's fixtures. The suite is small enough that
    // serial execution is still fast.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
