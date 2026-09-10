import type { Metadata } from 'next';
import { DocsArticle } from '@/components/docs/DocsArticle';

export const metadata: Metadata = {
  title: 'Docs — Whitespace',
  description:
    'How the vault-backed, oracle-priced perpetual works: the two-phase order lifecycle, slippage protection, isolated margin and liquidation, and the k-of-N signed oracle.',
};

/**
 * /docs — the protocol explained to someone about to put collateral into it.
 *
 * Content is grounded in `docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md`
 * and `docs/decisions/*.md`, and every parameter that can be read from the chain is read
 * from the chain rather than transcribed — because the documents themselves disagree about
 * what is deployed, and a page about security cannot resolve that by picking a favourite.
 */
export default function DocsPage() {
  return <DocsArticle />;
}
