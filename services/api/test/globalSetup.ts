import { startEphemeralPostgres } from './pgHarness.js';

// Vitest `globalSetup`: runs once in the main process before any test file,
// and process.env mutations made here ARE visible to the worker processes
// that run the actual test files (this is the documented/standard place to
// stand up a shared test database). See vitest.config.ts.
export default async function setup(): Promise<() => Promise<void>> {
  const harness = await startEphemeralPostgres();
  process.env.DATABASE_URL = harness.connectionString;

  // No publisher by default. src/publisher.ts reads this per call and treats the empty
  // string as "disabled", so every route falls back to on-chain data deterministically.
  // Left unset, the suite would reach for http://127.0.0.1:8787 and pick up whatever a
  // developer happened to have running — which is exactly how the price assertions
  // started failing against live BTC. A test that wants the publisher path sets this
  // itself, pointing at a stub it controls (see test/price.test.ts).
  process.env.PUBLISHER_URL = '';

  return async () => {
    harness.stop();
  };
}
