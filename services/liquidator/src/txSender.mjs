/**
 * Sends OstiumTradesUpKeep.performUpkeep as a legacy type-0 transaction, with local
 * nonce management and gas-price bumping on revert/failure, dead-lettering the trigger
 * once retries are exhausted. Mirrors services/keeper/src/txSender.mjs's retry/bump/
 * dead-letter shape closely (same failure domain: "tx reverts -> gas bump, nonce
 * management, dead-letter queue", design spec §7) but targets a different contract
 * (OstiumTradesUpKeep, not the price upkeep) and a different payload (a
 * SimplifiedTradeId[] trigger, not a signed price report) — this is new functionality
 * the keeper does not have, not a reimplementation of report delivery, which the keeper
 * continues to own entirely unmodified (see docs/decisions/phase-6-liquidator.md).
 *
 * Kept independent of any real RPC: publicClient/walletClient are viem-shaped but fully
 * injectable, so this is unit-testable with plain mocks — see
 * test/txSender.test.mjs.
 */

import { encodeFunctionData } from 'viem';
import { TRADES_UPKEEP_ABI } from './abi.mjs';
import { encodeLiquidationPerformData } from './performData.mjs';

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
 * @param {import('viem').Account} opts.account the liquidator's own forwarder account
 *   (must be registered via OstiumTradesUpKeep.registerForwarder — a separate
 *   allowlist entry from the keeper's, see docs/decisions/phase-6-liquidator.md for why
 *   this means liquidation is not literally permissionless as currently wired)
 * @param {`0x${string}`} opts.tradesUpKeepAddress
 * @param {ReturnType<typeof import('./deadLetter.mjs').createDeadLetterQueue>} opts.deadLetter
 * @param {number} [opts.maxRetries]
 */
export function createTxSender({ publicClient, walletClient, account, tradesUpKeepAddress, deadLetter, maxRetries = DEFAULT_MAX_RETRIES }) {
  let cachedNonce = null;

  async function refreshNonce() {
    cachedNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    return cachedNonce;
  }

  /**
   * @param {{ trader: `0x${string}`, pairIndex: number, index: number }} candidate
   * @param {number} timestamp
   */
  async function submitLiquidation(candidate, timestamp) {
    if (cachedNonce === null) await refreshNonce();

    let gasPrice = await publicClient.getGasPrice();
    const performData = encodeLiquidationPerformData([candidate], timestamp);
    const data = encodeFunctionData({ abi: TRADES_UPKEEP_ABI, functionName: 'performUpkeep', args: [performData] });

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const nonce = cachedNonce;
      try {
        const hash = await walletClient.sendTransaction({
          account,
          to: tradesUpKeepAddress,
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
          continue;
        }
      }
      gasPrice = (gasPrice * GAS_BUMP_NUMERATOR) / GAS_BUMP_DENOMINATOR;
    }

    deadLetter.add({
      trader: candidate.trader,
      pairIndex: candidate.pairIndex,
      index: candidate.index,
      reason: lastError?.message ?? 'unknown',
      attempts: maxRetries + 1,
    });
    return { ok: false, reason: lastError?.message ?? 'unknown' };
  }

  return {
    submitLiquidation,
    refreshNonce,
    get nonce() {
      return cachedNonce;
    },
  };
}
