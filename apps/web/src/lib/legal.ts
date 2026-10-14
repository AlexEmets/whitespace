/**
 * The Terms of Use and Privacy Policy: their version, the jurisdictions the Terms exclude,
 * and the record that this browser has agreed to the current version.
 *
 * There is no legal entity behind Whitespace yet, so the documents speak for "the
 * contributors" and name no governing law or registered address. Before mainnet they need
 * a lawyer's review; until then they state plainly what the testnet is and is not.
 */

/** Bump when the Terms change materially: every browser is asked to agree again.
 * 2026-10-14: points may count toward a possible future airdrop (they promised nothing before). */
export const TERMS_VERSION = '2026-10-14';
export const TERMS_LAST_UPDATED = '14 October 2026';
/** The Privacy Policy is dated on its own: a change to the Terms is not a change to it. */
export const PRIVACY_LAST_UPDATED = '13 October 2026';

/** Published once there is one; the documents say so rather than print a made-up address. */
export const LEGAL_CONTACT: string | null = null;

/**
 * Where the Terms say Whitespace may not be used. Leveraged derivatives are what regulators
 * watch most closely, so this follows what comparable perpetuals venues exclude: the United
 * States and Ontario for derivatives rules, and comprehensive sanctions programmes.
 */
export const RESTRICTED_JURISDICTIONS: readonly string[] = [
  'the United States of America, including its territories',
  'the Province of Ontario, Canada',
  'Cuba',
  'Iran',
  'North Korea',
  'Syria',
  'Russia',
  'Belarus',
  'the Russia-occupied territories of Ukraine: Crimea and Sevastopol, and the occupied parts of the Donetsk, Luhansk, Zaporizhzhia and Kherson regions',
  'any other country or territory subject to comprehensive sanctions by the United Nations, the European Union, the United Kingdom or the United States',
];

export const TERMS_ACCEPTED_KEY = 'whitespace:terms-accepted';
const CHANGE_EVENT = 'whitespace:terms-accepted';

type MaybeStorage = Pick<Storage, 'getItem' | 'setItem'> | undefined;

function defaultStorage(): MaybeStorage {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Where storage is blocked, an agreement still holds for the rest of the page session. */
let acceptedThisSession: string | null = null;

/** Whether this browser has agreed to `version` of the Terms. */
export function hasAcceptedTerms(storage: MaybeStorage = defaultStorage(), version: string = TERMS_VERSION): boolean {
  if (acceptedThisSession === version) return true;
  try {
    return storage?.getItem(TERMS_ACCEPTED_KEY) === version;
  } catch {
    return false;
  }
}

/** Records agreement to the current Terms and tells every listener in this tab. */
export function acceptTerms(storage: MaybeStorage = defaultStorage(), version: string = TERMS_VERSION): void {
  acceptedThisSession = version;
  try {
    storage?.setItem(TERMS_ACCEPTED_KEY, version);
  } catch {
    // Blocked storage: the session flag above carries it until the tab closes.
  }
  globalThis.dispatchEvent?.(new Event(CHANGE_EVENT));
}

/** For useSyncExternalStore: agreement made here, or in another tab. */
export function subscribeTermsAccepted(onChange: () => void): () => void {
  globalThis.addEventListener?.(CHANGE_EVENT, onChange);
  globalThis.addEventListener?.('storage', onChange);
  return () => {
    globalThis.removeEventListener?.(CHANGE_EVENT, onChange);
    globalThis.removeEventListener?.('storage', onChange);
  };
}

/** Test seam: forget the in-memory agreement. */
export function __resetTermsSession(): void {
  acceptedThisSession = null;
}
