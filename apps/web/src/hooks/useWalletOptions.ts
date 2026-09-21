'use client';

import { useMemo } from 'react';
import type { Connector } from 'wagmi';
import { useConnect } from 'wagmi';
import { GENERIC_INJECTED_ID, KNOWN_WALLETS, type KnownWallet } from '@/lib/wallets';

export type DetectedWallet = {
  kind: 'detected';
  key: string;
  name: string;
  /** The wallet's own logo, a data URI it supplied over EIP-6963. Absent for the generic connector. */
  icon?: string | undefined;
  brandColor?: string | undefined;
  /** Shown under the name so two builds of the same wallet stay tellable apart. */
  detail?: string | undefined;
  connector: Connector;
};

export type InstallableWallet = {
  kind: 'install';
  key: string;
  name: string;
  brandColor: string;
  installUrl: string;
};

export type WalletOption = DetectedWallet | InstallableWallet;

export function isDetected(option: WalletOption): option is DetectedWallet {
  return option.kind === 'detected';
}

function findAnnounced(
  wallet: KnownWallet,
  announced: readonly Connector[],
  claimed: ReadonlySet<string>,
): Connector | undefined {
  const free = announced.filter((connector) => !claimed.has(connector.uid));
  return (
    free.find((connector) => wallet.rdns.includes(connector.id)) ??
    free.find((connector) => wallet.namePattern.test(connector.name))
  );
}

/**
 * Turns wagmi's connector list into the rows the picker renders.
 *
 * Exported separately from the hook so it can be tested against a plain array — the
 * ordering rules below are the whole point of this module and deserve assertions that
 * do not need a React tree or a live browser.
 *
 * Order: known-and-installed (registry order) → other announced wallets → the generic
 * fallback → known-but-missing.
 */
export function deriveWalletOptions(connectors: readonly Connector[]): WalletOption[] {
  const generic = connectors.find((connector) => connector.id === GENERIC_INJECTED_ID);
  const announced = connectors.filter((connector) => connector.id !== GENERIC_INJECTED_ID);

  const claimed = new Set<string>();
  const installed: DetectedWallet[] = [];
  const missing: InstallableWallet[] = [];

  for (const wallet of KNOWN_WALLETS) {
    const match = findAnnounced(wallet, announced, claimed);
    if (match) {
      claimed.add(match.uid);
      installed.push({
        kind: 'detected',
        key: wallet.key,
        name: wallet.name,
        icon: match.icon,
        brandColor: wallet.brandColor,
        detail: match.id,
        connector: match,
      });
    } else {
      missing.push({
        kind: 'install',
        key: wallet.key,
        name: wallet.name,
        brandColor: wallet.brandColor,
        installUrl: wallet.installUrl,
      });
    }
  }

  const others: DetectedWallet[] = announced
    .filter((connector) => !claimed.has(connector.uid))
    .map((connector) => ({
      kind: 'detected',
      key: `rdns:${connector.id}`,
      name: connector.name,
      icon: connector.icon,
      detail: connector.id,
      connector,
    }));

  /**
   * The untargeted `injected()` connector resolves whatever extension won the race for
   * `window.ethereum`. Offering it alongside announced wallets is precisely the bug this
   * picker fixes — clicking "MetaMask" would work while clicking the duplicate silently
   * opened Trust. So it is only a row when nothing announced itself at all, which is the
   * case for wallets too old for EIP-6963 and for the e2e mock.
   */
  const fallback: DetectedWallet[] =
    announced.length === 0 && generic
      ? [{ kind: 'detected', key: GENERIC_INJECTED_ID, name: 'Browser wallet', detail: 'window.ethereum', connector: generic }]
      : [];

  return [...installed, ...others, ...fallback, ...missing];
}

/**
 * `connectable` drives the header button's single-option fast path: with one wallet
 * there is no choice to make, so Connect goes straight to it instead of opening a
 * dialog with one row in it.
 */
export function useWalletOptions(): { options: WalletOption[]; connectable: DetectedWallet[] } {
  const { connectors } = useConnect();

  return useMemo(() => {
    const options = deriveWalletOptions(connectors);
    return { options, connectable: options.filter(isDetected) };
  }, [connectors]);
}
