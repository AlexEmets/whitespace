/**
 * Sends performUpkeep as a legacy type-0 transaction with local nonce management and
 * gas-price bumping on revert/failure, dead-lettering the order once retries are
 * exhausted. "Keeper tx reverts -> gas bump, nonce management, dead-letter queue"
 * (design spec §7).
 *
 * Kept independent of any real RPC: `publicClient`/`walletClient` are viem-shaped but
 * fully injectable, so the retry/bump/dead-letter state machine is unit-tested with
 * plain mock objects, no chain required.
 */

import { encodeFunctionData } from 'viem';
import { PRICE_UPKEEP_ABI } from './abi.mjs';

/** Gas price multiplier per retry, as an exact integer ratio (1.2x). */
export const GAS_BUMP_NUMERATOR = 12n;
export const GAS_BUMP_DENOMINATOR = 10n;
export const DEFAULT_MAX_RETRIES = 3;

function isNonceError(err) {
  return /nonce/i.test(String(err?.message ?? err ?? ''));
}

/**
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.publicClient
 * @param {import('viem').WalletClient} opts.walletClient
 * @param {import('viem').Account} opts.account the forwarder account
 * @param {`0x${string}`} opts.priceUpKeepAddress
 * @param {ReturnType<typeof import('./deadLetter.mjs').createDeadLetterQueue>} opts.deadLetter
 * @param {number} [opts.maxRetries]
 */
export function createTxSender({ publicClient, walletClient, account, priceUpKeepAddress, deadLetter, maxRetries = DEFAULT_MAX_RETRIES }) {
  let cachedNonce = null;

  async function refreshNonce() {
    cachedNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    return cachedNonce;
  }

  /**
   * @param {{ orderId: bigint, performData: `0x${string}` }} args
   */
  async function send({ orderId, performData }) {
    if (cachedNonce === null) await refreshNonce();

    let gasPrice = await publicClient.getGasPrice();
    const data = encodeFunctionData({ abi: PRICE_UPKEEP_ABI, functionName: 'performUpkeep', args: [performData] });

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const nonce = cachedNonce;
      try {
        const hash = await walletClient.sendTransaction({
          account,
          to: priceUpKeepAddress,
          data,
          nonce,
          gasPrice,
          type: 'legacy',
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === 'success') {
          cachedNonce = nonce + 1;
          return { ok: true, hash, attempt };
        }
        lastError = new Error(`tx reverted: ${hash}`);
      } catch (err) {
        lastError = err;
        if (isNonceError(err)) {
          await refreshNonce();
          continue; // retry immediately at the corrected nonce; not a gas bump
        }
      }
      gasPrice = (gasPrice * GAS_BUMP_NUMERATOR) / GAS_BUMP_DENOMINATOR;
    }

    deadLetter.add({ orderId, reason: lastError?.message ?? 'unknown', attempts: maxRetries + 1 });
    return { ok: false, reason: lastError?.message ?? 'unknown' };
  }

  return {
    send,
    refreshNonce,
    get nonce() {
      return cachedNonce;
    },
  };
}
