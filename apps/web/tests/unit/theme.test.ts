import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  applyTheme,
  isTheme,
  nextTheme,
  readStoredTheme,
} from '@/lib/theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme model', () => {
  it('knows its two themes and nothing else', () => {
    expect(isTheme('solar')).toBe(true);
    expect(isTheme('lunar')).toBe(true);
    expect(isTheme('dark')).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it('defaults to the warm Solar theme the design was approved in', () => {
    expect(DEFAULT_THEME).toBe('solar');
  });

  it('toggles between the two', () => {
    expect(nextTheme('solar')).toBe('lunar');
    expect(nextTheme('lunar')).toBe('solar');
  });
});

describe('readStoredTheme', () => {
  it('returns the stored choice', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'lunar');
    expect(readStoredTheme()).toBe('lunar');
  });

  it('falls back to the default for anything it does not recognise', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readStoredTheme()).toBe('solar');
  });

  it('falls back to the default when storage itself is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readStoredTheme(blocked)).toBe('solar');
  });
});

describe('applyTheme', () => {
  it('sets the theme on the root element, where the CSS tokens key off it', () => {
    applyTheme('lunar');
    expect(document.documentElement.getAttribute('data-theme')).toBe('lunar');
  });
});

describe('THEME_INIT_SCRIPT', () => {
  // The inline script runs before React, so a returning Lunar user never sees a flash of
  // Solar while the bundle loads.
  it('applies a stored theme before first paint', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'lunar');
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('lunar');
  });

  it('leaves the server-rendered theme alone for a junk value', () => {
    document.documentElement.setAttribute('data-theme', 'solar');
    window.localStorage.setItem(THEME_STORAGE_KEY, '"><script>');
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('solar');
  });
});
