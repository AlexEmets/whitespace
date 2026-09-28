import type { PublicClient } from 'viem';

/**
 * Headroom on top of the node's gas estimate, in percent.
 *
 * An estimate runs against the LATEST block, but the transaction lands in a later one, where a
 * write can cost more: `updateTp` right after an open stores a timestamp that is a cheap
 * same-value rewrite in the estimating block and a fresh write (~2.9k gas more) in the next.
 * The full-stack acceptance run on anvil hit exactly that and ran out of gas. Wallets do not
 * reliably pad on their own, so every trading write sets its own limit.
 */
export const GAS_HEADROOM_PERCENT = 30n;

export function withHeadroom(estimate: bigint): bigint {
  return estimate + (estimate * GAS_HEADROOM_PERCENT + 99n) / 100n;
}

/** Estimates `request` (a viem contract-write request) and returns it with a padded gas limit. */
export async function padGas<T extends Parameters<PublicClient['estimateContractGas']>[0]>(
  publicClient: PublicClient,
  request: T,
): Promise<T & { gas: bigint }> {
  const estimate = await publicClient.estimateContractGas(request);
  return { ...request, gas: withHeadroom(estimate) };
}
