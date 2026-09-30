'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseEther, type Address } from 'viem';
import { useAccount, useBalance, usePublicClient, useReadContract, useWalletClient } from 'wagmi';
import { TRADING_ABI } from '@/lib/abi';
import { TRADING_ADDRESS } from '@/lib/deployment';
import { padGas } from '@/lib/gas';
import {
  buildSessionWalletClient,
  clearSessionKey,
  createSessionKey,
  delegatedActionArgs,
  getSessionKey,
  SESSION_KEY_GAS_TOPUP_WBT,
  SESSION_KEY_LOW_GAS_WEI,
  type SessionKey,
} from '@/lib/sessionKey';
import { confirmTx, describeTxError } from '@/lib/tx';

export interface ManagedSendResult {
  hash: `0x${string}`;
  receipt: Awaited<ReturnType<typeof confirmTx>>;
}

export interface SessionKeyState {
  /** The browser-held session key for the connected wallet, if one has been generated. */
  sessionAddress: Address | null;
  /** The delegate registered on-chain for the connected wallet (address(0) → none). */
  registeredDelegate: Address | null;
  /** True when the local session key is the on-chain delegate — trades can skip the wallet popup. */
  active: boolean;
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

  const [sessionKey, setSessionKey] = useState<SessionKey | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load (or forget) the persisted session key whenever the connected wallet changes. A key is
  // scoped to its trader, so switching accounts must never surface the previous account's key.
  useEffect(() => {
    setSessionKey(address ? getSessionKey(address) : null);
    setError(null);
  }, [address]);

  const delegation = useReadContract({
    address: TRADING_ADDRESS,
    abi: TRADING_ABI,
    functionName: 'delegations',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
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
  const lowGas = active && gasWei !== null && gasWei < SESSION_KEY_LOW_GAS_WEI;

  const sendGasTopUp = useCallback(
    async (to: Address) => {
      if (!walletClient || !publicClient) return;
      const hash = await walletClient.sendTransaction({ to, value: parseEther(SESSION_KEY_GAS_TOPUP_WBT) });
      await confirmTx(publicClient, hash, 'fund the session key');
      await gas.refetch();
    },
    [walletClient, publicClient, gas],
  );

  const enable = useCallback(async () => {
    if (!address || !walletClient || !publicClient) return;
    setError(null);
    setEnabling(true);
    try {
      const key = sessionKey ?? createSessionKey(address);
      setSessionKey(key);
      const hash = await walletClient.writeContract({
        address: TRADING_ADDRESS,
        abi: TRADING_ABI,
        functionName: 'setDelegate',
        args: [key.address],
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
  }, [address, walletClient, publicClient, sessionKey, delegation, sendGasTopUp]);

  const disable = useCallback(async () => {
    if (!address || !walletClient || !publicClient) return;
    setError(null);
    setDisabling(true);
    try {
      const hash = await walletClient.writeContract({
        address: TRADING_ADDRESS,
        abi: TRADING_ABI,
        functionName: 'removeDelegate',
      });
      await confirmTx(publicClient, hash, 'turn off one-click trading');
      clearSessionKey(address);
      setSessionKey(null);
      await delegation.refetch();
    } catch (err) {
      setError(describeTxError(err));
    } finally {
      setDisabling(false);
    }
  }, [address, walletClient, publicClient, delegation]);

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
      const hash = await client.writeContract(await padGas(publicClient, request as never));
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
    [sessionAddress, registeredDelegate, active, enabling, disabling, funding, error, gasWei, lowGas, enable, disable, fundGas, send],
  );
}
