import { parseEther, type Address } from 'viem';
import { CHAIN_ID } from './config';

/**
 * What a freshly connected wallet is missing before it can trade, and whether it has
 * already been offered the setup dialog (components/GetStarted.tsx).
 *
 * A new tester arrives with nothing: no WBT, so they cannot sign even the USDW claim, and
 * no USDW to put up as margin. Both are free on /faucet, but nothing said so — the first
 * thing a new wallet met was an order ticket it could not use.
 */

/**
 * Below this a wallet cannot count on paying for its next few transactions. An order
 * costs about 0.003 WBT at the testnet's 5 gwei, so 0.01 is a handful of them — enough to
 * claim USDW and place a first trade, not enough to call the wallet set up.
 */
export const LOW_GAS_WEI = parseEther('0.01');

export interface FundingNeeds {
  /** Too little WBT to pay for the next few transactions. */
  gas: boolean;
  /** No USDW to use as margin. */
  collateral: boolean;
}

/** `null` while either balance is still unread: nothing can be said about the wallet yet. */
export function fundingNeeds(wbtWei: bigint | null, usdwRaw: bigint | null): FundingNeeds | null {
  if (wbtWei === null || usdwRaw === null) return null;
  return { gas: wbtWei < LOW_GAS_WEI, collateral: usdwRaw === 0n };
}

export function needsFunding(needs: FundingNeeds | null): boolean {
  return needs !== null && (needs.gas || needs.collateral);
}

/** WBT to four places, rounded down — enough to tell 0.3 from 0.0003 without a wei tail. */
export function formatWbt(wei: bigint): string {
  const tenThousandths = wei / 10n ** 14n;
  const whole = tenThousandths / 10_000n;
  const frac = (tenThousandths % 10_000n).toString().padStart(4, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

type MaybeStorage = Pick<Storage, 'getItem' | 'setItem'> | undefined;

function defaultStorage(): MaybeStorage {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function getStartedSeenKey(owner: Address, chainId: number = CHAIN_ID): string {
  return `whitespace:get-started:${chainId}:${owner.toLowerCase()}`;
}

/** Whether this browser has already offered the setup dialog to `owner`. */
export function hasSeenGetStarted(owner: Address, storage: MaybeStorage = defaultStorage()): boolean {
  try {
    return storage?.getItem(getStartedSeenKey(owner)) === '1';
  } catch {
    return false;
  }
}

export function markGetStartedSeen(owner: Address, storage: MaybeStorage = defaultStorage()): void {
  try {
    storage?.setItem(getStartedSeenKey(owner), '1');
  } catch {
    // No persistence (private window, blocked storage): the caller's in-memory guard still
    // keeps it to once per page session.
  }
}
