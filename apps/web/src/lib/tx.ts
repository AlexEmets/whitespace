import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  parseAbi,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { COLLATERAL_DECIMALS } from './config';
import { formatMoney } from './money';

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

/**
 * Custom errors this app can say something useful about. Neither lives in an ABI the UI
 * already loads — `ERC20InsufficientBalance` is OpenZeppelin's, raised inside the
 * collateral token during a `safeTransferFrom` the trader never sees, and `CooldownActive`
 * belongs to the mock faucet — so they are declared here and matched against the raw
 * revert data rather than discovered through the contract ABI.
 */
const EXPLAINED_ERRORS = parseAbi([
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error CooldownActive(uint256 availableAt)',
]);

/** A wallet that produces no viem error still sets the EIP-1193 rejection code. */
function rejectedInWallet(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) return true;
  return (err as { code?: unknown } | null | undefined)?.code === 4001;
}

function revertData(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.raw : undefined;
}

function explainRevert(data: Hex): string | null {
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: EXPLAINED_ERRORS, data });
  } catch {
    // Not one of ours — the selector belongs to some other contract's error.
    return null;
  }

  if (decoded.errorName === 'ERC20InsufficientBalance') {
    const [, balance, needed] = decoded.args as readonly [string, bigint, bigint];
    // Named in USDW rather than raw units, and deliberately silent about WHICH action is
    // short. An earlier version named closing specifically and explained that the oracle fee
    // comes out of the wallet. That is true of the contracts deployed today and stops being
    // true the moment the close-bond migration lands — after it, closing charges the fee to
    // the position and this error can only come from opening or from a vault deposit. A
    // message that has to be re-edited in lockstep with a contract migration will be wrong
    // for whatever window separates the two deploys, so it states only the two figures, which
    // hold either way.
    // See docs/superpowers/specs/2026-09-22-close-without-wallet-balance-design.md.
    return `Not enough USDW in your wallet: this needs ${formatMoney(needed, COLLATERAL_DECIMALS)} and you hold ${formatMoney(balance, COLLATERAL_DECIMALS)}.`;
  }

  if (decoded.errorName === 'CooldownActive') {
    const [availableAt] = decoded.args as readonly [bigint];
    const when = new Date(Number(availableAt) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `The faucet has already paid this address — it mints once per address per 24h. It unlocks again at ${when}.`;
  }

  return null;
}

/**
 * One sentence a trader can act on, or `null` for "say nothing".
 *
 * Every write path used to render `err.message`, which for a viem error is a
 * multi-paragraph block carrying the calldata, a docs link and a version stamp. That got
 * printed into a table cell next to a position. This is the one place that decides what a
 * failed write says, so a new write path cannot reintroduce the dump by omission.
 *
 * `null` for a rejection is deliberate rather than lazy: the trader pressed Reject a
 * second ago. Restating it in red implies something went wrong, and nothing did.
 */
export function describeTxError(err: unknown): string | null {
  if (rejectedInWallet(err)) return null;

  const data = revertData(err);
  if (data) {
    const explained = explainRevert(data);
    if (explained) return explained;
  }

  // `shortMessage` is viem's own one-line summary; `message` is the block. Split anyway —
  // a custom BaseError subclass is free to put a newline in either.
  if (err instanceof BaseError) return err.shortMessage.split('\n')[0] ?? err.shortMessage;
  if (err instanceof Error) return err.message.split('\n')[0] ?? err.message;
  return String(err);
}
