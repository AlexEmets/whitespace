'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { parseEther, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { useAccount, useBalance, usePublicClient, useReadContract, useWalletClient } from 'wagmi';
import { TRADING_ABI } from '@/lib/abi';
import { whitechainTestnet1874 } from '@/lib/chain';
import { TRADING_ADDRESS } from '@/lib/deployment';
import { padGas } from '@/lib/gas';
import {
  buildSessionWalletClient,
  clearSessionKey,
  createSessionKey,
  delegatedActionArgs,
  loadSessionPrivateKey,
  SESSION_KEY_GAS_TOPUP_WBT,
  SESSION_KEY_LOW_GAS_WEI,
  subscribeSessionKeys,
} from '@/lib/sessionKey';
import { confirmTx, describeTxError } from '@/lib/tx';
import { useEnsureTestnet } from './useTestnetWriteContract';

/** How often the on-chain delegate is re-read. */
export const DELEGATION_REFRESH_MS = 10_000;

/** The node refused a send for want of native balance (viem's InsufficientFundsError, or its message). */
function isOutOfGas(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /InsufficientFunds|insufficient funds|exceeds the balance of the account/i.test(text);
}

export interface ManagedSendResult {
  hash: `0x${string}`;
  receipt: Awaited<ReturnType<typeof confirmTx>>;
}

export interface SessionKeyState {
  /** The browser-held session key for the connected wallet, if one has been generated. */
  sessionAddress: Address | null;
  /** The delegate registered on-chain for the connected wallet (address(0) → none). */
  registeredDelegate: Address | null;
  /** True when the local session key is the on-chain delegate (the badge shows "On"). */
  active: boolean;
  /**
   * True when trades should actually go through the session key: it is the delegate AND it
   * holds gas. The delegate is registered one transaction before the key is funded, and a
   * trade signed in between failed with the node's raw "total cost exceeds the balance".
   * Until then — or once the key runs dry — trades fall back to the wallet.
   */
  ready: boolean;
  enabling: boolean;
  disabling: boolean;
  funding: boolean;
  error: string | null;
  /** Session key's WBT (gas) balance in wei, or null before it is known. */
  gasWei: bigint | null;
  /** True when the session key is active but nearly out of gas to sign with. */
  lowGas: boolean;
  /** Registers a fresh session key as the delegate (one signature) and tops up its gas. */
  enable: () => Promise<void>;
  /** Revokes the on-chain delegate (one signature) and wipes the local key. */
  disable: () => Promise<void>;
  /** Sends more WBT gas from the trader's wallet to the session key (one signature). */
  fundGas: () => Promise<void>;
  /**
   * Sends a Trading write through the session key with no wallet popup, by wrapping it in
   * delegatedAction. Only valid when `active`; throws otherwise. Simulated first so a revert
   * surfaces as a reason, exactly like the wallet path.
   */
  send: (functionName: string, args: readonly unknown[], describe: string) => Promise<ManagedSendResult>;
}

/**
 * One-click trading for the connected wallet.
 *
 * When enabled, the terminal holds a session key (a local burner EOA) that the trader has
 * registered on-chain as their delegate. Every trade is then signed locally by that key and
 * executed as the trader via `delegatedAction` — no wallet popup per trade. See lib/sessionKey.ts
 * for why a browser-held key is bounded to trading only and cannot move funds to itself.
 */
export function useSessionKey(): SessionKeyState {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  // The wallet signs three things here (delegate, revoke, gas top-up) through its own
  // client rather than useWriteContract, so it gets the same guard by hand: switch to 1874
  // first, and name the chain so viem refuses to sign on any other (useTestnetWriteContract).
  const ensureTestnet = useEnsureTestnet();

  // One store for every instance of this hook (see subscribeSessionKeys): the key enabled from
  // the toggle must be the key the order ticket signs with. The snapshot is the hex string,
  // which compares by value, so the store never reports a change that did not happen.
  const privateKey = useSyncExternalStore(
    subscribeSessionKeys,
    () => (address ? loadSessionPrivateKey(address) : null),
    () => null,
  );
  const sessionKey = useMemo(() => {
    if (!privateKey) return null;
    const account = privateKeyToAccount(privateKey);
    return { privateKey, account, address: account.address };
  }, [privateKey]);
  const [enabling, setEnabling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A key is scoped to its trader (the store above reads the connected address's key), so a
  // switch of accounts never surfaces the previous account's key; only the error is reset here.
  useEffect(() => {
    setError(null);
  }, [address]);

  const delegation = useReadContract({
    address: TRADING_ADDRESS,
    abi: TRADING_ABI,
    functionName: 'delegations',
    args: address ? [address] : undefined,
    // Re-read on a timer: a delegate revoked or replaced from another device or tab would
    // otherwise keep the badge on "On" while every trade reverts NotDelegate.
    query: { enabled: Boolean(address), refetchInterval: DELEGATION_REFRESH_MS },
  });
  const registeredDelegate = (delegation.data as Address | undefined) ?? null;

  const sessionAddress = sessionKey?.address ?? null;
  const active = Boolean(
    sessionAddress &&
      registeredDelegate &&
      registeredDelegate !== '0x0000000000000000000000000000000000000000' &&
      registeredDelegate.toLowerCase() === sessionAddress.toLowerCase(),
  );

  const gas = useBalance({ address: sessionAddress ?? undefined, query: { enabled: Boolean(sessionAddress) } });
  const gasWei = gas.data ? gas.data.value : null;
  const ready = active && gasWei !== null && gasWei > 0n;
  const lowGas = active && gasWei !== null && gasWei < SESSION_KEY_LOW_GAS_WEI;

  const sendGasTopUp = useCallback(
    async (to: Address) => {
      if (!walletClient || !publicClient) return;
      await ensureTestnet();
      const hash = await walletClient.sendTransaction({
        to,
        value: parseEther(SESSION_KEY_GAS_TOPUP_WBT),
        chain: whitechainTestnet1874,
      });
      await confirmTx(publicClient, hash, 'fund the session key');
      await gas.refetch();
    },
    [walletClient, publicClient, gas, ensureTestnet],
  );

  const enable = useCallback(async () => {
    if (!address) return;
    // wagmi hands out the wallet client a moment after connecting. Returning silently here
    // made "Enable one-click trading" a button that did nothing at all when clicked early.
    if (!walletClient || !publicClient) {
      setError('Your wallet is not ready yet — try again in a moment.');
      return;
    }
    setError(null);
    setEnabling(true);
    try {
      const key = sessionKey ?? createSessionKey(address);
      await ensureTestnet();
      const hash = await walletClient.writeContract({
        address: TRADING_ADDRESS,
        abi: TRADING_ABI,
        functionName: 'setDelegate',
        args: [key.address],
        chain: whitechainTestnet1874,
      });
      await confirmTx(publicClient, hash, 'enable one-click trading');
      await delegation.refetch();
      // Fund the key so its first trade does not stall for gas. A funding failure must not
      // undo the delegation, which is the part that matters — surface it as a soft warning.
      try {
        const balance = await publicClient.getBalance({ address: key.address });
        if (balance < SESSION_KEY_LOW_GAS_WEI) await sendGasTopUp(key.address);
      } catch {
        setError('One-click trading is on, but topping up gas failed. Use “Fund gas” before trading.');
      }
    } catch (err) {
      setError(describeTxError(err));
    } finally {
      setEnabling(false);
    }
  }, [address, walletClient, publicClient, sessionKey, delegation, sendGasTopUp, ensureTestnet]);

  const disable = useCallback(async () => {
    if (!address) return;
    if (!walletClient || !publicClient) {
      setError('Your wallet is not ready yet — try again in a moment.');
      return;
    }
    setError(null);
    setDisabling(true);
    try {
      await ensureTestnet();
      const hash = await walletClient.writeContract({
        address: TRADING_ADDRESS,
        abi: TRADING_ABI,
        functionName: 'removeDelegate',
        chain: whitechainTestnet1874,
      });
      await confirmTx(publicClient, hash, 'turn off one-click trading');
      clearSessionKey(address);
      await delegation.refetch();
    } catch (err) {
      setError(describeTxError(err));
    } finally {
      setDisabling(false);
    }
  }, [address, walletClient, publicClient, delegation, ensureTestnet]);

  const fundGas = useCallback(async () => {
    if (!sessionAddress) return;
    setError(null);
    setFunding(true);
    try {
      await sendGasTopUp(sessionAddress);
    } catch (err) {
      setError(describeTxError(err));
    } finally {
      setFunding(false);
    }
  }, [sessionAddress, sendGasTopUp]);

  const send = useCallback(
    async (functionName: string, args: readonly unknown[], describe: string): Promise<ManagedSendResult> => {
      if (!address) throw new Error('useSessionKey: wallet not connected');
      if (!publicClient) throw new Error('useSessionKey: no public client');
      if (!sessionKey || !active) throw new Error('useSessionKey: one-click trading is not active');

      const client = buildSessionWalletClient(sessionKey.account);
      const { request } = await publicClient.simulateContract({
        account: sessionKey.account,
        address: TRADING_ADDRESS,
        abi: TRADING_ABI,
        functionName: 'delegatedAction',
        args: delegatedActionArgs(address, functionName, args),
      });
      let hash: `0x${string}`;
      try {
        hash = await client.writeContract(await padGas(publicClient, request as never));
      } catch (err) {
        if (isOutOfGas(err)) {
          void gas.refetch();
          throw new Error('One-click trading is out of gas. Use “Fund gas”, or turn it off to sign with your wallet.');
        }
        throw err;
      }
      const receipt = await confirmTx(publicClient, hash, describe);
      void gas.refetch();
      return { hash, receipt };
    },
    [address, publicClient, sessionKey, active, gas],
  );

  return useMemo(
    () => ({
      sessionAddress,
      registeredDelegate,
      active,
      ready,
      enabling,
      disabling,
      funding,
      error,
      gasWei,
      lowGas,
      enable,
      disable,
      fundGas,
      send,
    }),
    [sessionAddress, registeredDelegate, active, ready, enabling, disabling, funding, error, gasWei, lowGas, enable, disable, fundGas, send],
  );
}
