import type { Metadata } from 'next';
import { ApiReference } from '@/components/docs/ApiReference';

export const metadata: Metadata = {
  title: 'API — Whitespace',
  description:
    'The public Whitespace API: markets, live prices, candles, positions, trade history, fees, points and the LP vault over REST and WebSocket. Read-only, no key.',
};

/** /docs/api — the public API reference. Content and its sources: components/docs/ApiReference.tsx. */
export default function ApiDocsPage() {
  return <ApiReference />;
}
