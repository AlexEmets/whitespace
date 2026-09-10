'use client';

import { parseAbi } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { ERC20_ABI } from '@/lib/abi';
import { COLLATERAL_ADDRESS, VAULT_ADDRESS } from '@/lib/deployment';

/**
 * The two on-chain balances the portfolio needs that no existing hook exposes.
 *
 * `useErc20` already reads USDW, but it is built around an approve/allowance flow for a
 * specific spender and pins a write surface this page never uses; the portfolio only wants
 * the balance. `useVault` covers the deposit/withdraw *lifecycle* and has no notion of an
 * LP's current position at all.
 *
 * `OstiumVault` is an `ERC4626Upgradeable`, so an LP's position is `balanceOf` (shares)
 * valued through `convertToAssets` (USDW). Both are inherited ERC-4626/ERC-20 views, and
 * `OstiumVault.decimals()` is overridden to a hard `6` (OstiumVault.sol:371) — shares
 * carry the same scale as the collateral, so both values format at COLLATERAL_DECIMALS.
 *
 * The ABI is declared here rather than added to `src/lib/abi.ts` because that file is not
 * this change's to edit; the source of each signature is named below the same way it is
 * there.
 */

// source: OstiumVault is ERC4626Upgradeable — `balanceOf`/`totalSupply` from ERC-20,
// `convertToAssets`/`totalAssets` from ERC-4626. `decimals()` is overridden to 6
// (OstiumVault.sol:371-373); `_convertToAssets` prices shares off `shareToAssetsPrice`
// (OstiumVault.sol:379-385).
const VAULT_SHARES_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
]);

export interface PortfolioBalances {
  /** Raw 6-decimal USDW sitting in the trader's wallet. `null` until it has been read. */
  walletRaw: bigint | null;
  /** Raw 6-decimal LP vault shares held. `null` until read. */
  vaultSharesRaw: bigint | null;
  /** Those shares valued in USDW, raw 6-decimal. `null` until read. */
  vaultAssetsRaw: bigint | null;
  /** Whole-vault TVL in USDW, raw 6-decimal — context for the LP tile. */
  vaultTotalAssetsRaw: bigint | null;
  loading: boolean;
  error: Error | null;
}

export function usePortfolioBalances(): PortfolioBalances {
  const { address } = useAccount();
  const enabled = Boolean(address);

  const wallet = useReadContract({
    address: COLLATERAL_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled, refetchInterval: 10_000 },
  });

  const shares = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_SHARES_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled, refetchInterval: 10_000 },
  });

  const sharesRaw = shares.data ?? null;

  const assets = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_SHARES_ABI,
    functionName: 'convertToAssets',
    args: sharesRaw === null ? undefined : [sharesRaw],
    // Valuing zero shares is a real answer (zero USDW), not a missing one, so this stays
    // enabled at a zero balance rather than leaving the LP tile permanently dashed.
    query: { enabled: enabled && sharesRaw !== null },
  });

  // Gated on the wallet like everything else here, even though vault TVL is public: it is
  // only ever rendered as context beside the LP tile, which does not exist without a
  // connection. The public RPC rate-limits under burst and answers a throttled preflight
  // without CORS headers, so every avoidable read is a console error waiting to happen on
  // a page that had nothing to show for it.
  const totalAssets = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_SHARES_ABI,
    functionName: 'totalAssets',
    query: { enabled, refetchInterval: 30_000 },
  });

  const failure = wallet.error ?? shares.error ?? assets.error ?? totalAssets.error ?? null;

  return {
    walletRaw: wallet.data ?? null,
    vaultSharesRaw: sharesRaw,
    vaultAssetsRaw: assets.data ?? null,
    vaultTotalAssetsRaw: totalAssets.data ?? null,
    loading: enabled && (wallet.isLoading || shares.isLoading),
    error: failure instanceof Error ? failure : failure ? new Error(String(failure)) : null,
  };
}
