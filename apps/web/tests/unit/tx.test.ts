import { describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeErrorResult,
  parseAbi,
} from 'viem';
import { TransactionRevertedError, confirmTx, describeTxError } from '@/lib/tx';

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

/**
 * Written from two real failures on Whitechain 1874.
 *
 * `0x8a357f2b…` — a `closeTradeMarket` that reverted with
 * `ERC20InsufficientBalance(0x43Ac…B06B, 57243, 1000000)`. Closing pulls the flat
 * `pairOracleFee` (1.00 USDW) straight from the trader's wallet
 * (OstiumTrading.sol:310-311) and the wallet held 0.057243. The UI rendered
 * "Transaction reverted on chain" and nothing else, so the one fact that would have
 * explained it — the trader needs a whole USDW in hand to close — was never shown.
 *
 * The same session's faucet claim reverted with `CooldownActive`, and a rejected close
 * before that rendered viem's full multi-paragraph dump, docs link and all, into a table
 * cell.
 */
describe('describeTxError', () => {
  const INSUFFICIENT = encodeErrorResult({
    abi: parseAbi(['error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)']),
    errorName: 'ERC20InsufficientBalance',
    args: ['0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B', 57243n, 1000000n],
  });

  function reverted(data: `0x${string}`) {
    return new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: [], data, functionName: 'closeTradeMarket' }),
      { abi: [], functionName: 'closeTradeMarket' },
    );
  }

  /** Rejecting is a deliberate act, not a fault. A red alert for it reads as a bug. */
  it('says nothing at all when the user rejected the signature', () => {
    const err = new ContractFunctionExecutionError(new UserRejectedRequestError(new Error('denied')), {
      abi: [],
      functionName: 'closeTradeMarket',
    });
    expect(describeTxError(err)).toBeNull();
  });

  it('says nothing for a bare EIP-1193 4001 from a wallet that throws no viem error', () => {
    expect(describeTxError({ code: 4001, message: 'User rejected the request.' })).toBeNull();
  });

  it('names both figures for an insufficient balance, in USDW rather than raw units', () => {
    const text = describeTxError(reverted(INSUFFICIENT)) ?? '';
    expect(text).toContain('1.00');
    expect(text).toContain('0.06');
    expect(text).not.toContain('57243');
    // The message must not name WHICH action is short. It used to say the oracle fee comes out
    // of the wallet on a close — true of the contracts deployed today, false once the close-bond
    // migration lands. Asserting only the figures let that claim ship unchallenged once already.
    expect(text).not.toMatch(/clos(e|ing)/i);
    expect(text).not.toMatch(/oracle fee/i);
  });

  it('says when the faucet unlocks rather than that a transaction reverted', () => {
    const availableAt = 1790097009n;
    const data = encodeErrorResult({
      abi: parseAbi(['error CooldownActive(uint256 availableAt)']),
      errorName: 'CooldownActive',
      args: [availableAt],
    });
    const text = describeTxError(reverted(data)) ?? '';
    expect(text).toMatch(/faucet/i);
    expect(text).toMatch(/already/i);
  });

  /**
   * Found in a QA pass on production: a too-small order came back as "The contract function
   * "openTrade" reverted with the following signature:" — and nothing after the colon. The
   * app's ABIs carry no error entries, so viem could not name the revert, and the selector
   * sat on the line the UI cut off.
   */
  describe('contract errors', () => {
    const OSTIUM = parseAbi(['error BelowFees()', 'error BelowMinLevPos()', 'error NotGov(address a)']);
    const encode = (errorName: 'BelowFees' | 'BelowMinLevPos') => encodeErrorResult({ abi: OSTIUM, errorName });

    it('tells the trader what BelowFees means and what to do', () => {
      expect(describeTxError(reverted(encode('BelowFees')))).toBe('This order is too small to cover its fees. Increase the size.');
    });

    it('tells the trader what BelowMinLevPos means and what to do', () => {
      expect(describeTxError(reverted(encode('BelowMinLevPos')))).toMatch(/below the market's minimum size.*Increase the size/);
    });

    it('names a contract error it has no sentence for, rather than showing a selector', () => {
      const data = encodeErrorResult({ abi: OSTIUM, errorName: 'NotGov', args: ['0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B'] });
      expect(describeTxError(reverted(data))).toBe('The contract refused this: NotGov.');
    });

    it('still says what happened when the error is unknown, never a sentence cut at its colon', () => {
      const text = describeTxError(reverted('0xdeadbeef')) ?? '';
      expect(text).toBe('The contract refused this transaction (error 0xdeadbeef).');
      expect(text).not.toMatch(/:$/);
    });
  });

  /** The complaint that started this: viem's `message` is a multi-paragraph block with a
   *  docs link and a version stamp, and five call sites rendered it verbatim. */
  it('never returns viem’s multi-line dump for an unrecognised error', () => {
    const err = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: [], data: '0xdeadbeef', functionName: 'closeTradeMarket' }), {
      abi: [],
      functionName: 'closeTradeMarket',
    });
    const text = describeTxError(err) ?? '';
    expect(text).not.toContain('\n');
    expect(text).not.toContain('viem.sh');
    expect(text).not.toMatch(/Request Arguments/i);
    expect(text.length).toBeGreaterThan(0);
  });

  it('passes a reverted-on-chain error through, since it is already one sentence', () => {
    const text = describeTxError(new TransactionRevertedError('close the position', HASH)) ?? '';
    expect(text).toContain('close the position');
    expect(text).not.toContain('\n');
  });

  it('falls back to a plain string for a non-Error throw', () => {
    expect(describeTxError('boom')).toBe('boom');
  });
});
