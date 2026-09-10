import type { Metadata } from 'next';
import { PointsPanel } from '@/components/points/PointsPanel';

export const metadata: Metadata = {
  title: 'Points — Whitespace',
  description:
    'Points issuance is not live. Your traded volume and the live fee schedule, with no invented totals, ranks or epochs.',
};

/**
 * /points.
 *
 * The design mockup fills this screen with a points total, a rank, an epoch countdown and
 * a referral share. None of those exist — there is no points service, no epoch schedule,
 * no leaderboard, and referral was cut from scope. Publishing any of them would be worse
 * than publishing nothing, because a points balance reads as a claim on a future
 * allocation and traders act on it.
 *
 * So the page keeps the mockup's shape and answers each of those four slots honestly, then
 * fills the rest with what is genuinely verifiable for the connected address: traded
 * notional from its own closed-position history, and the fee schedule read live from the
 * contracts.
 */
export default function PointsPage() {
  return <PointsPanel />;
}
