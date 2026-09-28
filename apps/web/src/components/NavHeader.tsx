'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useHealth } from '@/hooks/useHealth';
import { ChainGuard } from './ChainGuard';
import { ThemeToggle } from './ThemeToggle';
import { WalletConnect } from './WalletConnect';

const NAV_LINKS: Array<{ href: string; label: string; testId: string }> = [
  { href: '/trade', label: 'Trade', testId: 'trade' },
  { href: '/vaults', label: 'Vaults', testId: 'vaults' },
  { href: '/portfolio', label: 'Portfolio', testId: 'portfolio' },
  { href: '/points', label: 'Points', testId: 'points' },
  { href: '/docs', label: 'Docs', testId: 'docs' },
  { href: '/faucet', label: 'Faucet', testId: 'faucet' },
];

/** Shared header across every page: the eclipse wordmark, nav, and the live chain/health
 * readout — block and latency, both real (see useHealth.ts), never placeholder numbers —
 * plus the wallet control.
 *
 * The small eclipse behind the header is drawn on every page except the landing page,
 * whose hero draws the large one; two eclipses on one screen would compete.
 *
 * On a phone the links fold behind a menu button (globals.css hides the button above
 * 900px), and the menu closes itself on navigation so it never covers the page it opened. */
export function NavHeader() {
  const pathname = usePathname();
  const { indexedBlock, latencyMs } = useHealth();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Escape closes an open menu, as it would any other popover.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <>
      {pathname !== '/' ? <div className="eclipse-backdrop" aria-hidden="true" data-testid="eclipse-backdrop" /> : null}
      <header className="nav-header">
        <Link href="/" className="wordmark" data-testid="wordmark">
          <span className="wordmark-mark" aria-hidden="true" />
          whitespace
        </Link>
        <nav id="site-nav" className={`nav-links${menuOpen ? ' open' : ''}`} data-testid="site-nav">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={pathname?.startsWith(link.href) ? 'active' : ''}
              data-testid={`nav-${link.testId}`}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="nav-right">
          <span className="chain-health" data-testid="chain-health">
            <span className="live-dot" aria-hidden="true" />
            <span>
              {/* Number() because /health serialises the block as a decimal string despite the
                  type; a block height is a count, not money, so the float path is safe. */}
              WHITECHAIN · <strong>{indexedBlock !== null ? Number(indexedBlock).toLocaleString('en-US') : '—'}</strong>
            </span>
            <span className="latency">· {latencyMs ?? '—'} ms</span>
          </span>
          <ThemeToggle />
          <WalletConnect />
          <button
            type="button"
            className="menu-button"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="site-nav"
            data-testid="menu-button"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
        </div>
      </header>
      <ChainGuard />
    </>
  );
}
