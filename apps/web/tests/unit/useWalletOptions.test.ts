import { describe, expect, it } from 'vitest';
import type { Connector } from 'wagmi';
import { deriveWalletOptions, describeProvider } from '@/hooks/useWalletOptions';

/**
 * Regression cover for the bug this module exists to fix: `WalletConnect` used to
 * connect `connectors[0]`, which is always wagmi's untargeted `injected()` connector —
 * i.e. whichever extension won the race for `window.ethereum`. On a machine running both
 * MetaMask and Trust that is Trust, every time, and MetaMask was unreachable even though
 * wagmi had already discovered it over EIP-6963 and appended it to the same array.
 *
 * `deriveWalletOptions` is a plain function over that array precisely so the ordering and
 * de-duplication rules can be asserted without a React tree or a real browser.
 */

function fakeConnector(id: string, name: string, icon?: string): Connector {
  return { uid: `uid:${id}`, id, name, icon, type: 'injected' } as unknown as Connector;
}

const GENERIC = fakeConnector('injected', 'Injected');
const METAMASK = fakeConnector('io.metamask', 'MetaMask', 'data:image/svg+xml;base64,TU0=');
const TRUST = fakeConnector('com.trustwallet.app', 'Trust Wallet', 'data:image/svg+xml;base64,VFc=');
const RABBY = fakeConnector('io.rabby', 'Rabby Wallet', 'data:image/svg+xml;base64,UkI=');

describe('deriveWalletOptions', () => {
  it('offers MetaMask and Trust as separate rows bound to their own connectors', () => {
    const options = deriveWalletOptions([GENERIC, METAMASK, TRUST]);

    expect(options.map((option) => option.key)).toEqual(['metamask', 'trust']);
    expect(options.every((option) => option.kind === 'detected')).toBe(true);
    // The point of the whole change: picking MetaMask must hand back MetaMask's
    // connector, not the generic one that resolves to whoever owns window.ethereum.
    expect(options[0]).toMatchObject({ kind: 'detected', connector: METAMASK });
    expect(options[1]).toMatchObject({ kind: 'detected', connector: TRUST });
  });

  it('hides the generic injected connector once anything has announced itself', () => {
    const options = deriveWalletOptions([GENERIC, METAMASK, TRUST]);

    expect(options.map((option) => option.key)).not.toContain('injected');
  });

  it('falls back to the generic connector when nothing announces over EIP-6963', () => {
    const options = deriveWalletOptions([GENERIC]);

    expect(options[0]).toMatchObject({ kind: 'detected', key: 'injected', connector: GENERIC });
  });

  it('keeps an uninstalled wallet visible as an install link instead of dropping it', () => {
    const options = deriveWalletOptions([GENERIC, METAMASK]);

    expect(options[0]).toMatchObject({ kind: 'detected', key: 'metamask' });
    expect(options[1]).toMatchObject({
      kind: 'install',
      key: 'trust',
      installUrl: 'https://trustwallet.com/download',
    });
  });

  it('lists an unrecognised wallet after the named ones rather than discarding it', () => {
    const options = deriveWalletOptions([METAMASK, RABBY]);

    expect(options.map((option) => option.key)).toEqual(['metamask', 'rdns:io.rabby', 'trust']);
  });

  it('matches a wallet by name when it announces an rdns the registry has never seen', () => {
    const unknownBuild = fakeConnector('com.trustwallet.nightly', 'Trust Wallet');
    const options = deriveWalletOptions([unknownBuild]);

    expect(options[0]).toMatchObject({ kind: 'detected', key: 'trust', connector: unknownBuild });
  });

  it('never lets one connector fill two rows', () => {
    const secondBuild = fakeConnector('com.trustwallet.nightly', 'Trust Wallet');
    const options = deriveWalletOptions([TRUST, secondBuild]);

    expect(options.map((option) => option.key)).toEqual([
      'trust',
      'rdns:com.trustwallet.nightly',
      'metamask',
    ]);
    expect(options[0]).toMatchObject({ connector: TRUST });
  });

  it('offers both install links when the browser has no wallet at all', () => {
    const options = deriveWalletOptions([]);

    expect(options).toHaveLength(2);
    expect(options.every((option) => option.kind === 'install')).toBe(true);
  });

  /**
   * The near-miss this design walked into: a wallet too old for EIP-6963 announces
   * nothing and exists only at window.ethereum. With a newer MetaMask installed beside
   * it, "something announced" is true — and hiding the generic row on that basis would
   * have left the older wallet unreachable, which is worse than the connectors[0] bug.
   */
  it('keeps a wallet that never announced reachable beside one that did', () => {
    const options = deriveWalletOptions([GENERIC, METAMASK], {
      isDistinct: true,
      name: 'Trust Wallet',
      brandColor: '#3375bb',
    });

    expect(options.map((option) => option.key)).toEqual(['metamask', 'injected', 'trust']);
    expect(options[1]).toMatchObject({ kind: 'detected', name: 'Trust Wallet', connector: GENERIC });
  });

  it('still drops the generic row when it is the same provider an announced wallet wraps', () => {
    const options = deriveWalletOptions([GENERIC, METAMASK], { isDistinct: false, name: 'MetaMask' });

    expect(options.map((option) => option.key)).toEqual(['metamask', 'trust']);
  });
});

describe('describeProvider', () => {
  it('believes isTrust over isMetaMask, because Trust sets both', () => {
    expect(describeProvider({ isMetaMask: true, isTrust: true })).toMatchObject({ name: 'Trust Wallet' });
  });

  it('names a plain MetaMask provider', () => {
    expect(describeProvider({ isMetaMask: true })).toMatchObject({ name: 'MetaMask' });
  });

  it('falls back to a neutral label for an unrecognised provider', () => {
    expect(describeProvider({})).toMatchObject({ name: 'Browser wallet' });
    expect(describeProvider(null)).toMatchObject({ name: 'Browser wallet' });
  });
});
