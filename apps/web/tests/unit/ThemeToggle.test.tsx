import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from '@/components/ThemeToggle';
import { THEME_STORAGE_KEY } from '@/lib/theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'solar');
});

describe('<ThemeToggle>', () => {
  it('offers the other theme by name', () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('aria-label', 'Switch to the Lunar (cold) theme');
  });

  it('switches the page and remembers the choice', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('lunar');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('lunar');
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('aria-label', 'Switch to the Solar (warm) theme');

    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('solar');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('solar');
  });

  it('starts from the theme the pre-paint script already applied', () => {
    document.documentElement.setAttribute('data-theme', 'lunar');
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-theme-current', 'lunar');
  });
});
