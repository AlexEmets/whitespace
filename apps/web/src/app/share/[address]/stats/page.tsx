import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { apiFetchJson, loadStatsCard } from '@/lib/shareData';
import { statsImagePath, statsShareText } from '@/lib/statsCard';

/**
 * /share/:address/stats — the page a shared stats link opens. As with a trade link, its job
 * is mostly its <head>: the og/twitter tags make X and Telegram show the stats card as a
 * large preview. A person who clicks through sees the card and a way into the terminal.
 */
export const dynamic = 'force-dynamic';

type Params = Promise<{ address: string }>;
type Search = Promise<{ t?: string | string[] }>;

/** One API lookup per request, shared by the metadata and the page body. */
const load = cache((address: string, theme: string | undefined) => loadStatsCard({ address, theme }, apiFetchJson()));

function themeParam(t: string | string[] | undefined): string | undefined {
  return Array.isArray(t) ? t[0] : t;
}

const DESCRIPTION =
  'Perpetual futures on Whitechain testnet — one shared vault takes the other side, priced by a signed oracle.';

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const { address } = await params;
  const result = await load(address, themeParam((await searchParams).t));
  if (!result) return { title: 'No trades yet — Whitespace' };

  const title = statsShareText(result.card);
  const image = { url: statsImagePath(address, result.theme), width: 1200, height: 630, alt: title };
  return {
    title: `${title} — Whitespace`,
    description: DESCRIPTION,
    openGraph: { title, description: DESCRIPTION, siteName: 'Whitespace', type: 'website', images: [image] },
    twitter: { card: 'summary_large_image', title, description: DESCRIPTION, images: [image.url] },
  };
}

export default async function StatsSharePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { address } = await params;
  const result = await load(address, themeParam((await searchParams).t));
  if (!result) notFound();

  const title = statsShareText(result.card);
  return (
    <div className="share-page">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="share-image" src={statsImagePath(address, result.theme)} alt={title} width={1200} height={630} />
      <h1>{title}</h1>
      <p>Whitespace is a perpetuals exchange on Whitechain testnet. USDW is a test token with no value.</p>
      <div className="cta-row">
        <Link href="/trade" className="btn-primary">
          Trade on Whitespace
        </Link>
        <Link href="/points" className="btn-secondary">
          See the leaderboard
        </Link>
      </div>
    </div>
  );
}
