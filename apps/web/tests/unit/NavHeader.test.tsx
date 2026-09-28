import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavHeader } from '@/components/NavHeader';

let pathname = '/trade';

vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
// jsdom cannot navigate; the stand-in link keeps the click (and its handler) without it.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/useHealth', () => ({ useHealth: () => ({ indexedBlock: '9004269', latencyMs: 70 }) }));
vi.mock('@/components/WalletConnect', () => ({ WalletConnect: () => null }));
vi.mock('@/components/ChainGuard', () => ({ ChainGuard: () => null }));

beforeEach(() => {
  pathname = '/trade';
});

describe('<NavHeader>', () => {
  it('groups the block height the API sends as a decimal string', () => {
    render(<NavHeader />);
    expect(screen.getByTestId('chain-health')).toHaveTextContent('9,004,269');
  });

  it('leads the home link with the brand mark and names it by the wordmark alone', () => {
    render(<NavHeader />);
    const home = screen.getByTestId('wordmark');
    expect(home).toHaveAccessibleName('whitespace');
    expect(home.querySelector('svg.wordmark-mark[aria-hidden="true"]')).not.toBeNull();
  });

  it('draws the header eclipse everywhere but the landing page', () => {
    const { rerender } = render(<NavHeader />);
    expect(screen.getByTestId('eclipse-backdrop')).toBeInTheDocument();
    pathname = '/';
    rerender(<NavHeader />);
    expect(screen.queryByTestId('eclipse-backdrop')).not.toBeInTheDocument();
  });

  it('opens and closes the phone menu from its button', () => {
    render(<NavHeader />);
    const button = screen.getByTestId('menu-button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('site-nav')).not.toHaveClass('open');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-label', 'Close menu');
    expect(screen.getByTestId('site-nav')).toHaveClass('open');

    fireEvent.click(button);
    expect(screen.getByTestId('site-nav')).not.toHaveClass('open');
  });

  it('closes the menu on Escape', () => {
    render(<NavHeader />);
    fireEvent.click(screen.getByTestId('menu-button'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('site-nav')).not.toHaveClass('open');
  });

  it('closes the menu when a link in it is followed', () => {
    render(<NavHeader />);
    fireEvent.click(screen.getByTestId('menu-button'));
    fireEvent.click(screen.getByTestId('nav-vaults'));
    expect(screen.getByTestId('site-nav')).not.toHaveClass('open');
  });

  it('closes the menu when the route changes under it', () => {
    const { rerender } = render(<NavHeader />);
    fireEvent.click(screen.getByTestId('menu-button'));
    pathname = '/portfolio';
    rerender(<NavHeader />);
    expect(screen.getByTestId('site-nav')).not.toHaveClass('open');
    expect(screen.getByTestId('nav-portfolio')).toHaveClass('active');
  });
});
