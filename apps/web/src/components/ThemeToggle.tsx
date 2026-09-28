'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_THEME, THEME_STORAGE_KEY, applyTheme, isTheme, nextTheme, type Theme } from '@/lib/theme';

const LABEL: Record<Theme, string> = {
  solar: 'Switch to the Lunar (cold) theme',
  lunar: 'Switch to the Solar (warm) theme',
};

/** Header control that swaps the Solar and Lunar themes. It shows the theme in force (a sun
 * or a moon) and names the one a click switches to. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  // The pre-paint script in the root layout has already put the stored theme on <html>;
  // read it from there after mount rather than guessing during the server render.
  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    if (isTheme(current)) setTheme(current);
  }, []);

  function toggle() {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Not remembered across visits; the switch itself still works.
    }
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={LABEL[theme]}
      title={LABEL[theme]}
      data-testid="theme-toggle"
      data-theme-current={theme}
      onClick={toggle}
    >
      {theme === 'solar' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  );
}
