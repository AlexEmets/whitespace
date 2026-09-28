'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useHealth } from '@/hooks/useHealth';
import { ChainGuard } from './ChainGuard';
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
 * whose hero draws the large one; two eclipses on one screen would compete. */
export function NavHeader() {
  const pathname = usePathname();
  const { indexedBlock, latencyMs } = useHealth();

  return (
    <>
      {pathname !== '/' ? <div className="eclipse-backdrop" aria-hidden="true" data-testid="eclipse-backdrop" /> : null}
      <header className="nav-header">
        <Link href="/" className="wordmark" data-testid="wordmark">
          <span className="wordmark-mark" aria-hidden="true" />
          whitespace
        </Link>
        <nav className="nav-links">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={pathname?.startsWith(link.href) ? 'active' : ''}
              data-testid={`nav-${link.testId}`}
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
          <WalletConnect />
        </div>
      </header>
      <ChainGuard />
    </>
  );
}
