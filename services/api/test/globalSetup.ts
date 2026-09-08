import { startEphemeralPostgres } from './pgHarness.js';

// Vitest `globalSetup`: runs once in the main process before any test file,
// and process.env mutations made here ARE visible to the worker processes
// that run the actual test files (this is the documented/standard place to
// stand up a shared test database). See vitest.config.ts.
export default async function setup(): Promise<() => Promise<void>> {
  const harness = await startEphemeralPostgres();
  process.env.DATABASE_URL = harness.connectionString;

  return async () => {
    harness.stop();
  };
}
