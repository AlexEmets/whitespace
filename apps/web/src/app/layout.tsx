import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NavHeader } from '@/components/NavHeader';
import { Providers } from '@/components/Providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Whitespace — Whitechain Perp DEX',
  description: 'Trade perpetual futures on Whitechain testnet.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <NavHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
