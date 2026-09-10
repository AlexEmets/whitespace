import type { Metadata } from 'next';
import { PortfolioView } from '@/components/portfolio/PortfolioView';

export const metadata: Metadata = {
  title: 'Portfolio — Whitespace',
  description: 'Account value, open positions, unrealised and realised PnL across every Whitespace market.',
};

/**
 * /portfolio — the cross-market account view.
 *
 * Every figure comes from a source that can be checked: `GET /positions/:address` and its
 * `/history` for trading activity, `GET /orders/:address` for anything still in flight,
 * and direct contract reads for the USDW wallet balance and the LP vault position. The
 * page composes those into one account value and also shows its parts, so the total is
 * always reconcilable against the rows beneath it — and renders an explained dash instead
 * of a total whenever one of those parts could not be read.
 */
export default function PortfolioPage() {
  return <PortfolioView />;
}
