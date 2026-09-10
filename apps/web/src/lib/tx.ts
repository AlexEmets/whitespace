import type { Hash, PublicClient, TransactionReceipt } from 'viem';

/**
 * Wait for a transaction and REFUSE to proceed unless it actually succeeded.
 *
 * `waitForTransactionReceipt` resolves for a reverted transaction exactly as it does for a
 * successful one — the failure is a `status` field on the receipt, not a rejection. Every
 * write path in this app awaited it and then ignored `status`, so a revert flowed onward
 * as success.
 *
 * That produced the worst kind of bug this interface can have. A real `openTrade` reverted
 * with `ERC20InsufficientAllowance`, and the order panel rendered "Order requested (id —).
 * … The position opens once a keeper delivers the signed price report" while the wallet
 * beside it said "Interaction failed". The trader is told to wait for a fill that can
 * never come, and the one number that would have given it away — the order id — renders as
 * the same em-dash the app uses for "not known yet".
 *
 * Throwing here turns that into the error state each caller already knows how to render.
 * It lives in one place so that a new write path cannot reintroduce the gap by omission:
 * the only way to get a receipt is to get a checked one.
 */
export async function confirmTx(
  publicClient: PublicClient,
  hash: Hash,
  /** What the user was trying to do, e.g. "open the position". Used in the error text. */
  action: string,
): Promise<TransactionReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new TransactionRevertedError(action, hash);
  }
  return receipt;
}

/**
 * A revert, in the terms the trader cares about: what failed, and where to look.
 *
 * The chain's own reason is not recoverable here — an EVM revert reason is not in the
 * receipt, and re-simulating to recover it would report the state at a *later* block than
 * the one that failed, which can produce a different (and therefore misleading) answer.
 * Better to state plainly that it reverted and hand over the hash than to guess at why.
 */
export class TransactionRevertedError extends Error {
  readonly hash: Hash;

  constructor(action: string, hash: Hash) {
    super(`Transaction reverted on chain — could not ${action}. Nothing was changed and your funds were not moved. Transaction: ${hash}`);
    this.name = 'TransactionRevertedError';
    this.hash = hash;
  }
}
