'use client';

import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { ERC20_ABI, VAULT_ABI, VAULT_REQUEST_STATUS, type VaultRequestStatus } from '@/lib/abi';
import { VAULT_ADDRESS } from '@/lib/deployment';
import { confirmTx } from '@/lib/tx';

/**
 * The caller's LP share balance, raw.
 *
 * Shares are the vault's own ERC20, not the collateral token, so `useErc20` (pinned to
 * COLLATERAL_ADDRESS) cannot answer this. Withdrawing needs it: `requestWithdraw` is
 * denominated in SHARES, and a request for more than the wallet holds reverts inside
 * `_transfer` — the same on-chain-revert-after-gas failure the deposit balance guard was
 * written for (see VaultPanel's test).
 *
 * Refetches on an interval because `requestWithdraw` moves the shares into the vault's
 * own balance: the number drops the moment a request lands, and a cached value would show
 * the user shares they no longer control.
 *
 * `OstiumVault.decimals()` is a hardcoded 6 (OstiumVault.sol:371-373), the same as USDW,
 * so COLLATERAL_DECIMALS formats both.
 */
/** Total assets the vault reports holding, raw 6-decimal USDW. A real contract read
 * (`IOstiumVault.tvl`), so it is 0 when the vault is genuinely empty and `null` only
 * while the read is in flight — the two are not the same claim and are not rendered the
 * same way. */
export function useVaultTvl() {
  const result = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: 'tvl',
    query: { refetchInterval: 15000 },
  });
  return { tvl: result.data ?? null, loading: result.isLoading };
}

export function useVaultShares() {
  const { address } = useAccount();
  const result = useReadContract({
    address: VAULT_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 5000 },
  });
  return { shares: result.data ?? 0n, refetch: result.refetch };
}

/**
 * LP deposit/withdraw flow (design: "Deposit/withdraw USDW to the vault (LP flow) —
 * `requestDeposit` / settlement / `claimDeposit`"). This is genuinely async: a request
 * only becomes claimable after a settlement runs (IOstiumVault.sol's `RequestStatus`
 * lifecycle: NONE -> PENDING -> CLAIMABLE|RECLAIMABLE). The UI must not claim to have
 * deposited until the claim step actually succeeds.
 */
export function useVault() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  async function requestDeposit(assetsRaw: bigint): Promise<{ hash: `0x${string}`; settlementId: number }> {
    if (!publicClient) throw new Error('useVault: no public client');
    // Read the settlement id this request will target *before* submitting, so the UI can
    // poll/claim against the right id afterwards without guessing.
    const settlementId = await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'targetSettlementId',
      args: [true],
    });
    const hash = await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'requestDeposit',
      args: [assetsRaw],
    });
    await confirmTx(publicClient, hash, 'complete the vault operation');
    return { hash, settlementId: Number(settlementId) };
  }

  async function claimDeposit(settlementId: number): Promise<`0x${string}`> {
    const hash = await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'claimDeposit',
      args: [settlementId],
    });
    if (publicClient) await confirmTx(publicClient, hash, 'complete the vault operation');
    return hash;
  }

  async function requestWithdraw(sharesRaw: bigint): Promise<{ hash: `0x${string}`; settlementId: number }> {
    if (!publicClient) throw new Error('useVault: no public client');
    const settlementId = await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'targetSettlementId',
      args: [false],
    });
    const hash = await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'requestWithdraw',
      args: [sharesRaw],
    });
    await confirmTx(publicClient, hash, 'complete the vault operation');
    return { hash, settlementId: Number(settlementId) };
  }

  async function claimWithdraw(settlementId: number): Promise<`0x${string}`> {
    const hash = await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'claimWithdraw',
      args: [settlementId],
    });
    if (publicClient) await confirmTx(publicClient, hash, 'complete the vault operation');
    return hash;
  }

  /**
   * The two escape hatches the lifecycle needs and this hook did not have.
   *
   * `RequestStatus` is NONE -> PENDING -> CLAIMABLE|RECLAIMABLE, and the UI only ever
   * offered a button on CLAIMABLE. The other two live states each strand funds:
   *
   *   PENDING      the settlement has not run. `cancelRequest*` withdraws the request and
   *                returns the assets/shares. Without it the only way out is to wait for a
   *                settlement that may be arbitrarily far off.
   *   RECLAIMABLE  the settlement ran and did NOT fill the request. `claim*` reverts here;
   *                `reclaim*` is the correct call. With neither button rendered, a user in
   *                this state has money in the contract and no control in the product.
   *
   * `cancelRequest*` takes the amount as well as the settlement id because a request can
   * be cancelled partially — callers pass the full amount to withdraw it entirely.
   */
  async function cancelRequestDeposit(settlementId: number, assetsRaw: bigint): Promise<`0x${string}`> {
    const hash = await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'cancelRequestDeposit',
      args: [settlementId, assetsRaw],
    });
    if (publicClient) await confirmTx(publicClient, hash, 'cancel the deposit request');
    return hash;
  }

  async function cancelRequestWithdraw(settlementId: number, sharesRaw: bigint): Promise<`0x${string}`> {
    const hash = await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'cancelRequestWithdraw',
      args: [settlementId, sharesRaw],
    });
    if (publicClient) await confirmTx(publicClient, hash, 'cancel the withdrawal request');
    return hash;
  }

  async function reclaimDeposit(settlementId: number): Promise<`0x${string}`> {
    const hash = await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'reclaimDeposit',
      args: [settlementId],
    });
    if (publicClient) await confirmTx(publicClient, hash, 'reclaim the deposit');
    return hash;
  }

  async function reclaimWithdraw(settlementId: number): Promise<`0x${string}`> {
    const hash = await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'reclaimWithdraw',
      args: [settlementId],
    });
    if (publicClient) await confirmTx(publicClient, hash, 'reclaim the shares');
    return hash;
  }

  function useDepositStatus(settlementId: number | null) {
    const result = useReadContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'getDepositStatus',
      args: address && settlementId !== null ? [address, settlementId] : undefined,
      query: { enabled: Boolean(address) && settlementId !== null, refetchInterval: 3000 },
    });
    const status: VaultRequestStatus = VAULT_REQUEST_STATUS[result.data ?? 0] ?? 'NONE';
    return { status, refetch: result.refetch };
  }

  function useWithdrawStatus(settlementId: number | null) {
    const result = useReadContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'getWithdrawStatus',
      args: address && settlementId !== null ? [address, settlementId] : undefined,
      query: { enabled: Boolean(address) && settlementId !== null, refetchInterval: 3000 },
    });
    const status: VaultRequestStatus = VAULT_REQUEST_STATUS[result.data ?? 0] ?? 'NONE';
    return { status, refetch: result.refetch };
  }

  return {
    requestDeposit,
    claimDeposit,
    requestWithdraw,
    claimWithdraw,
    cancelRequestDeposit,
    cancelRequestWithdraw,
    reclaimDeposit,
    reclaimWithdraw,
    useDepositStatus,
    useWithdrawStatus,
    isPending,
  };
}
