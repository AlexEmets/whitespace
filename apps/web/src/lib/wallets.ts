/**
 * The wallets the picker names explicitly. This list does NOT limit what can connect —
 * anything a browser announces over EIP-6963 is offered (see useWalletOptions). It only
 * controls which wallets are promoted to the top of the list and which get an install
 * link when they are absent.
 */
export type KnownWallet = {
  /** Stable key for React lists and `data-testid`s. */
  key: string;
  name: string;
  /**
   * EIP-6963 `info.rdns` values — the primary match key. wagmi builds every discovered
   * connector as `injected({ target: { ...info, id: info.rdns, provider } })`, so a
   * connector's `id` *is* the rdns. Matching on it is exact, unlike sniffing
   * `window.ethereum` flags: Trust Wallet sets `isMetaMask: true`, and wagmi's own
   * `targetMap.metaMask` blocklist does not filter it out, so a flag-based match would
   * hand back Trust when the trader asked for MetaMask.
   *
   * Several values per wallet because a wallet ships separate builds (extension, Flask,
   * in-app mobile browser) that announce different rdns strings.
   */
  rdns: readonly string[];
  /** Fallback for a build whose rdns is not in the list above. */
  namePattern: RegExp;
  installUrl: string;
  /** Tints the monogram tile shown when the wallet is not installed. */
  brandColor: string;
};

export const KNOWN_WALLETS: readonly KnownWallet[] = [
  {
    key: 'metamask',
    name: 'MetaMask',
    rdns: ['io.metamask', 'io.metamask.flask', 'io.metamask.mobile'],
    namePattern: /^metamask/i,
    installUrl: 'https://metamask.io/download/',
    brandColor: '#e17726',
  },
  {
    key: 'trust',
    name: 'Trust Wallet',
    rdns: ['com.trustwallet.app', 'com.trustwallet.android', 'com.trustwallet.ios'],
    namePattern: /^trust\s*wallet/i,
    installUrl: 'https://trustwallet.com/download',
    brandColor: '#3375bb',
  },
];

/** The id wagmi gives the untargeted `injected()` connector in src/lib/wagmiConfig.ts. */
export const GENERIC_INJECTED_ID = 'injected';
