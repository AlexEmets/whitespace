import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RESTRICTED_JURISDICTIONS,
  TERMS_VERSION,
  __resetTermsSession,
  acceptTerms,
  hasAcceptedTerms,
  subscribeTermsAccepted,
} from '@/lib/legal';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const blockedStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
};

afterEach(() => {
  __resetTermsSession();
});

describe('agreement to the Terms', () => {
  it('has not been given in a browser that never agreed', () => {
    expect(hasAcceptedTerms(memoryStorage())).toBe(false);
  });

  it('is remembered once given', () => {
    const storage = memoryStorage();
    acceptTerms(storage);
    __resetTermsSession(); // a fresh page load: only storage remains
    expect(hasAcceptedTerms(storage)).toBe(true);
  });

  /** A material change to the Terms bumps the version, and everyone is asked again. */
  it('does not carry over to a newer version of the Terms', () => {
    const storage = memoryStorage();
    acceptTerms(storage, '2026-01-01');
    __resetTermsSession();
    expect(hasAcceptedTerms(storage, '2026-01-01')).toBe(true);
    expect(hasAcceptedTerms(storage, TERMS_VERSION)).toBe(false);
  });

  it('holds for the rest of the page session where storage is blocked', () => {
    expect(() => acceptTerms(blockedStorage)).not.toThrow();
    expect(hasAcceptedTerms(blockedStorage)).toBe(true);
    __resetTermsSession();
    expect(hasAcceptedTerms(blockedStorage)).toBe(false);
  });

  it('tells subscribers in this tab when it is given, and stops when unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTermsAccepted(listener);
    acceptTerms(memoryStorage());
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    acceptTerms(memoryStorage());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hears an agreement given in another tab', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTermsAccepted(listener);
    window.dispatchEvent(new StorageEvent('storage', { key: 'whitespace:terms-accepted' }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('restricted jurisdictions', () => {
  it('exclude the United States, the comprehensively sanctioned countries, Russia, Belarus and occupied Ukraine', () => {
    const all = RESTRICTED_JURISDICTIONS.join(' | ');
    for (const place of [
      'United States',
      'Ontario',
      'Cuba',
      'Iran',
      'North Korea',
      'Syria',
      'Russia',
      'Belarus',
      'Crimea',
      'Donetsk',
      'Luhansk',
      'Zaporizhzhia',
      'Kherson',
    ]) {
      expect(all).toContain(place);
    }
  });

  it('end with a catch-all for any comprehensively sanctioned place', () => {
    expect(RESTRICTED_JURISDICTIONS.at(-1)).toMatch(/comprehensive sanctions/);
  });
});
