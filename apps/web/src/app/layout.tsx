import type { Metadata, Viewport } from 'next';
import { Azeret_Mono, Geologica } from 'next/font/google';
import type { ReactNode } from 'react';
import { NavHeader } from '@/components/NavHeader';
import { Providers } from '@/components/Providers';
import { SITE_URL } from '@/lib/config';
import { DEFAULT_THEME, THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

/**
 * Two families, split by what the text is rather than by where it sits — the Eclipse
 * design (the approved "C3 v2" canvas board):
 *
 *   --font-sans  Geologica: headings, prose, labels, buttons, navigation
 *   --font-mono  Azeret Mono: every figure, every data cell, prices, addresses
 *
 * A column of prices in a proportional face stops lining up, and a label in a monospace
 * face reads as data; the split keeps each where it belongs.
 *
 * `next/font/google` self-hosts both: no runtime request to Google, no layout shift (Next
 * generates a metric-matched local fallback per family), no extra dependency. Only the
 * cuts globals.css declares are downloaded — 300 for the large light figures, 400 for
 * body and table text, 500 for emphasis and headings, 600 for the rare strong label.
 *
 * `variable` exposes each loaded family as its own custom property, which `--font-sans`
 * and `--font-mono` prepend to their fallback stacks in globals.css.
 */
const geologica = Geologica({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  // Render immediately in the fallback and swap the face in when it arrives: a trading
  // screen must never be blank while a font downloads.
  display: 'swap',
  variable: '--font-geologica',
});

const azeretMono = Azeret_Mono({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  display: 'swap',
  variable: '--font-azeret-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Whitespace — Whitechain Perp DEX',
  description: 'Trade perpetual futures on Whitechain testnet.',
};

/** `viewport-fit=cover` lets the page use the whole screen on notched phones (the header
 * pads itself by the safe-area insets instead), and the theme colour tints the mobile
 * browser's own toolbar to the page black rather than a white strip above the app. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#030305',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-paint script below may swap `data-theme` to the
    // visitor's stored choice before React hydrates, which is the whole point of it.
    <html lang="en" className={`${geologica.variable} ${azeretMono.variable}`} data-theme={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Providers>
          <NavHeader />
          <div className="page-root">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
