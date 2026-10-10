import { afterEach, describe, expect, it, vi } from 'vitest';

/** NEXT_PUBLIC_RPC_URL must reach every read the app makes, not only the session-key client. */
describe('the configured RPC URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is the chain default that wagmi and every viem client read from', async () => {
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://example.test/rpc');
    vi.resetModules();
    const { whitechainTestnet1874 } = await import('@/lib/chain');
    expect(whitechainTestnet1874.rpcUrls.default.http[0]).toBe('https://example.test/rpc');
  });

  it('falls back to the public endpoint when none is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', undefined as unknown as string);
    vi.resetModules();
    const { whitechainTestnet1874 } = await import('@/lib/chain');
    const { CHAIN_INFO } = await import('@/lib/config');
    expect(whitechainTestnet1874.rpcUrls.default.http[0]).toBe(CHAIN_INFO.rpc);
  });
});
