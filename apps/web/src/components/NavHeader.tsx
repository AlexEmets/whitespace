'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useHealth } from '@/hooks/useHealth';
import { ChainGuard } from './ChainGuard';
import { FundingButtons } from './FundingButtons';
import { WalletConnect } from './WalletConnect';

const NAV_LINKS: Array<{ href: string; label: string }> = [
  { href: '/trade', label: 'TRADE' },
  { href: '/vaults', label: 'VAULTS' },
  { href: '/points', label: 'POINTS' },
  { href: '/portfolio', label: 'PORTFOLIO' },
  { href: '/docs', label: 'DOCS' },
];

/** Shared header across every page: wordmark, nav, and the live chain/health readout —
 * `WHITECHAIN · BLOCK <indexedBlock> · <latencyMs> MS`, both real (see useHealth.ts),
 * never placeholder numbers — plus the wallet connect control. */
export function NavHeader() {
  const pathname = usePathname();
  const { indexedBlock, latencyMs } = useHealth();

  return (
    <>
      <header className="nav-header">
        <Link href="/" className="wordmark" data-testid="wordmark">
          WHITESPACE
        </Link>
        <nav className="nav-links">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={pathname?.startsWith(link.href) ? 'active' : ''}
              data-testid={`nav-${link.label.toLowerCase()}`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="nav-right">
          <span data-testid="chain-health">
            WHITECHAIN · BLOCK {indexedBlock ?? '—'} · {latencyMs ?? '—'} MS
          </span>
          <FundingButtons />
          <WalletConnect />
        </div>
      </header>
      <ChainGuard />
    </>
  );
}
