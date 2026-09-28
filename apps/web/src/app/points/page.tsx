import type { Metadata } from 'next';
import { PointsPanel } from '@/components/points/PointsPanel';

export const metadata: Metadata = {
  title: 'Points — Whitespace',
  description:
    'Season-one points: missions, time in market, day streaks and pool liquidity — confirmed from your on-chain activity, with the current accrual shown live.',
};

/**
 * /points.
 *
 * Season-one points, computed off-chain by the indexer from real on-chain activity and served
 * by GET /points/:address. The four components (missions, time in market, day streak, LP) and
 * their anti-farm caps are the rules in @whitespace/shared/points; the page adds a live view of
 * what is still accruing on open positions and pooled liquidity.
 */
export default function PointsPage() {
  return <PointsPanel />;
}
