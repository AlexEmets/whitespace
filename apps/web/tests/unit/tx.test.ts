import { describe, expect, it, vi } from 'vitest';
import { TransactionRevertedError, confirmTx } from '@/lib/tx';

/**
 * Written after a real revert on Whitechain 1874: `0x356a2a3b…`, an `openTrade` that
 * failed with `ERC20InsufficientAllowance` while the order panel displayed
 * "Order requested … the position opens once a keeper delivers the signed price report".
 *
 * The cause was that `waitForTransactionReceipt` resolves for a reverted transaction just
 * as it does for a successful one — the failure is a `status` field, not a rejection — and
 * every write path in the app ignored it.
 */

const HASH = '0xdeadbeef' as const;

function clientReturning(status: 'success' | 'reverted') {
  return { waitForTransactionReceipt: vi.fn(async () => ({ status, transactionHash: HASH })) } as never;
}

describe('confirmTx', () => {
  it('returns the receipt when the transaction succeeded', async () => {
    const receipt = await confirmTx(clientReturning('success'), HASH, 'open the position');
    expect(receipt.status).toBe('success');
  });

  it('throws on a reverted receipt instead of returning it as though it worked', async () => {
    await expect(confirmTx(clientReturning('reverted'), HASH, 'open the position')).rejects.toBeInstanceOf(
      TransactionRevertedError,
    );
  });

  it('names the action and the hash, and states that nothing moved', async () => {
    const err = (await confirmTx(clientReturning('reverted'), HASH, 'open the position').catch((e) => e)) as Error;
    expect(err.message).toContain('open the position');
    expect(err.message).toContain(HASH);
    // The trader's first question after a failure is whether they lost anything.
    expect(err.message).toMatch(/funds were not moved/i);
  });

  it('carries the hash on the error so a caller can link to it', async () => {
    const err = (await confirmTx(clientReturning('reverted'), HASH, 'close the position').catch(
      (e) => e,
    )) as TransactionRevertedError;
    expect(err.hash).toBe(HASH);
  });
});
