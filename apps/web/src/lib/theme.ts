/**
 * The two Eclipse themes. Only the accent and the corona change between them — the
 * surfaces stay near-black and the long/short colours stay teal and coral in both, so a
 * trader switching themes never has to relearn which colour is which side.
 *
 *   solar  the warm amber corona the design was approved in (default)
 *   lunar  a cold ice-blue corona, moonlight rather than sunlight
 *
 * The theme lives on `<html data-theme>`; globals.css keys its tokens off that attribute.
 */
export const THEMES = ['solar', 'lunar'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'solar';
export const THEME_STORAGE_KEY = 'whitespace.theme';

export function isTheme(value: unknown): value is Theme {
  return value === 'solar' || value === 'lunar';
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'solar' ? 'lunar' : 'solar';
}

/** The stored choice, or the default when there is none, it is unrecognised, or storage is
 * blocked (private windows, sandboxed frames). */
export function readStoredTheme(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Theme {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', theme);
}

/**
 * Inlined into <head> by the root layout and run before the first paint, so a returning
 * Lunar visitor never sees a flash of Solar while the bundle loads. It only ever writes one
 * of the two known names — whatever else is in storage is ignored.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='solar'||t==='lunar')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
