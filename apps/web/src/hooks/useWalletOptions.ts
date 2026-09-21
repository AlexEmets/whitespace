'use client';

import { useEffect, useMemo, useState } from 'react';
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

/** What the hook works out about `window.ethereum` — see the generic-row rule below. */
export type GenericInjectedInfo = {
  /** True when no announced connector wraps the same provider object. */
  isDistinct: boolean;
  name: string;
  brandColor?: string | undefined;
};

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
export function deriveWalletOptions(
  connectors: readonly Connector[],
  genericInfo?: GenericInjectedInfo,
): WalletOption[] {
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
   * `window.ethereum`. Listing it next to the wallet that already announced the *same*
   * provider object is the duplicate this picker exists to remove — two rows, one of
   * which silently opens somebody else.
   *
   * But suppressing it whenever anything announced is wrong in the other direction, and
   * wrong for exactly the wallet that prompted this work: a wallet too old for EIP-6963
   * announces nothing and lives only at `window.ethereum`. With a newer MetaMask also
   * installed, "something announced" is true, and hiding the generic connector would
   * make that older wallet unreachable — worse than the `connectors[0]` bug it replaced.
   *
   * So the test is identity, not count: show it when it points at a provider no announced
   * connector represents. `genericInfo` carries that answer (the comparison needs async
   * `getProvider()` calls, so the hook resolves it); absent it, fall back to the
   * conservative count rule.
   */
  const showGeneric = generic && (genericInfo ? genericInfo.isDistinct : announced.length === 0);
  const fallback: DetectedWallet[] =
    showGeneric && generic
      ? [
          {
            kind: 'detected',
            key: GENERIC_INJECTED_ID,
            name: genericInfo?.name ?? 'Browser wallet',
            brandColor: genericInfo?.brandColor,
            detail: 'window.ethereum',
            connector: generic,
          },
        ]
      : [];

  return [...installed, ...others, ...fallback, ...missing];
}

/**
 * Vendor flags, used ONLY to label the generic row — never to choose between wallets.
 * That distinction is the whole design: flag sniffing is unreliable precisely because
 * Trust Wallet (and a dozen others) set `isMetaMask: true`, which is why `isMetaMask`
 * is tested last here and why announced wallets are matched by rdns instead.
 */
const VENDOR_FLAGS: ReadonlyArray<{ flag: string; name: string; brandColor?: string }> = [
  { flag: 'isTrust', name: 'Trust Wallet', brandColor: '#3375bb' },
  { flag: 'isTrustWallet', name: 'Trust Wallet', brandColor: '#3375bb' },
  { flag: 'isRabby', name: 'Rabby' },
  { flag: 'isBraveWallet', name: 'Brave Wallet' },
  { flag: 'isCoinbaseWallet', name: 'Coinbase Wallet' },
  { flag: 'isOkxWallet', name: 'OKX Wallet' },
  { flag: 'isPhantom', name: 'Phantom' },
  { flag: 'isMetaMask', name: 'MetaMask', brandColor: '#e17726' },
];

export function describeProvider(provider: unknown): { name: string; brandColor?: string | undefined } {
  const flags = provider as Record<string, unknown> | null;
  if (flags) {
    for (const vendor of VENDOR_FLAGS) {
      if (flags[vendor.flag]) return { name: vendor.name, brandColor: vendor.brandColor };
    }
  }
  return { name: 'Browser wallet' };
}

/**
 * Resolves whether `window.ethereum` is a wallet that no announced connector already
 * covers, by comparing the actual provider objects rather than trusting names or counts.
 */
function useGenericInjectedInfo(connectors: readonly Connector[]): GenericInjectedInfo | undefined {
  const [info, setInfo] = useState<GenericInjectedInfo | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const generic = connectors.find((connector) => connector.id === GENERIC_INJECTED_ID);
    const announced = connectors.filter((connector) => connector.id !== GENERIC_INJECTED_ID);

    if (!generic) {
      setInfo(undefined);
      return undefined;
    }

    const resolve = async () => {
      // A connector whose wallet has since been removed rejects here; treat that as
      // "no provider" rather than letting it sink the whole comparison.
      const safely = async (connector: Connector) => connector.getProvider().catch(() => undefined);
      const [genericProvider, announcedProviders] = await Promise.all([
        safely(generic),
        Promise.all(announced.map(safely)),
      ]);
      if (cancelled) return;
      if (!genericProvider) {
        setInfo({ isDistinct: false, name: 'Browser wallet' });
        return;
      }
      const { name, brandColor } = describeProvider(genericProvider);
      setInfo({ isDistinct: !announcedProviders.includes(genericProvider), name, brandColor });
    };

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [connectors]);

  return info;
}

/**
 * `connectable` drives the header button's single-option fast path: with one wallet
 * there is no choice to make, so Connect goes straight to it instead of opening a
 * dialog with one row in it.
 */
export function useWalletOptions(): {
  options: WalletOption[];
  connectable: DetectedWallet[];
  genericInfo: GenericInjectedInfo | undefined;
} {
  const { connectors } = useConnect();
  const genericInfo = useGenericInjectedInfo(connectors);

  return useMemo(() => {
    const options = deriveWalletOptions(connectors, genericInfo);
    return { options, connectable: options.filter(isDetected), genericInfo };
  }, [connectors, genericInfo]);
}
