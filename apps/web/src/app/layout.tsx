import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { NavHeader } from '@/components/NavHeader';
import { Providers } from '@/components/Providers';
import './globals.css';

/**
 * The whole interface is set in JetBrains Mono (both mockups are monospace end to end —
 * every price, size and label is figure-aligned, which is the point of the typeface here).
 * globals.css has always declared it in `--font-mono`, but nothing ever loaded it, so
 * anyone without the font installed locally silently got a system fallback and lost the
 * design's metrics. `next/font/google` self-hosts it: no runtime request to Google, no
 * layout shift (Next generates a metric-matched local fallback), no extra dependency.
 *
 * Only the four cuts globals.css actually declares are downloaded — 400 for body/table
 * text, 500 for the headings, 600 for the terminal market symbol, 700 for the wordmark
 * and the ticker's <strong> prices. The rest of the family (100–300, 800) would be dead
 * weight on every page load.
 *
 * `variable` exposes the loaded family as its own custom property, which `--font-mono`
 * then prepends to the existing fallback stack in globals.css — every `var(--font-mono)`
 * consumer keeps working untouched.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  // Render immediately in the fallback and swap in JetBrains Mono when it arrives: a
  // trading screen must never be blank while a font downloads.
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: 'Whitespace — Whitechain Perp DEX',
  description: 'Trade perpetual futures on Whitechain testnet.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <body>
        <Providers>
          <NavHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
