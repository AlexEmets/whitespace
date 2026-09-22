import type { Metadata } from 'next';
import { JetBrains_Mono, Schibsted_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import { NavHeader } from '@/components/NavHeader';
import { Providers } from '@/components/Providers';
import './globals.css';

/**
 * Two families, split by what the text is rather than by where it sits.
 *
 * The interface used to be JetBrains Mono end to end, because the only two mockups that
 * existed then — landing_design.pdf and terminal_design.pdf — are set in IBM Plex Mono
 * throughout. The September mockups are not: docs/design/pages.pdf (points, portfolio,
 * docs) and the faucet mockup are set in Schibsted Grotesk, with monospace kept for the
 * figures, the tables and the small uppercase labels. Prose in a monospace face is
 * slower to read and wastes horizontal measure; a column of prices in a proportional one
 * stops lining up. The split follows that, so both mockup generations get what they
 * asked for:
 *
 *   --font-sans  headings, prose, buttons, link text
 *   --font-mono  every figure, every data table, the labels, the wordmark, the ticker
 *
 * `next/font/google` self-hosts both: no runtime request to Google, no layout shift
 * (Next generates a metric-matched local fallback per family), no extra dependency.
 *
 * Only the four cuts globals.css actually declares are downloaded per family — 400 for
 * body/table text, 500 for the headings, 600 for the terminal market symbol, 700 for the
 * wordmark and the ticker's <strong> prices. The rest of each family would be dead
 * weight on every page load.
 *
 * `variable` exposes each loaded family as its own custom property, which `--font-mono`
 * and `--font-sans` then prepend to their fallback stacks in globals.css — every
 * `var(--font-*)` consumer keeps working untouched.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  // Render immediately in the fallback and swap in JetBrains Mono when it arrives: a
  // trading screen must never be blank while a font downloads.
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

const schibstedGrotesk = Schibsted_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-schibsted-grotesk',
});

export const metadata: Metadata = {
  title: 'Whitespace — Whitechain Perp DEX',
  description: 'Trade perpetual futures on Whitechain testnet.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${schibstedGrotesk.variable} ${jetbrainsMono.variable}`}>
      <body>
        <Providers>
          <NavHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
