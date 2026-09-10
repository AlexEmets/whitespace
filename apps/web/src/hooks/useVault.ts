'use client';

import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { VAULT_ABI, VAULT_REQUEST_STATUS, type VaultRequestStatus } from '@/lib/abi';
import { VAULT_ADDRESS } from '@/lib/deployment';
import { confirmTx } from '@/lib/tx';

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
    useDepositStatus,
    useWithdrawStatus,
    isPending,
  };
}
