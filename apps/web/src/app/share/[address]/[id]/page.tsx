import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { parseShareId, shareImagePath, shareText } from '@/lib/shareCard';
import type { Theme } from '@/lib/theme';
import { apiFetchJson, loadShareCard } from '@/lib/shareData';

/**
 * /share/:address/:id — the page a shared PnL link opens. Its job is mostly its <head>: the
 * og/twitter tags make X and Telegram show the card image as a large preview. A person who
 * clicks through sees the same card and a way into the terminal.
 */
export const dynamic = 'force-dynamic';

type Params = Promise<{ address: string; id: string }>;
type Search = Promise<{ t?: string | string[] }>;

/** One API lookup per request, shared by the metadata and the page body. */
const load = cache((address: string, id: string, theme: string | undefined) =>
  loadShareCard({ address, id, theme }, apiFetchJson()),
);

function themeParam(t: string | string[] | undefined): string | undefined {
  return Array.isArray(t) ? t[0] : t;
}

function imagePath(address: string, id: string, theme: Theme): string {
  const ref = parseShareId(id);
  return ref ? shareImagePath(address, ref, theme) : '';
}

const DESCRIPTION =
  'Perpetual futures on Whitechain testnet — one shared vault takes the other side, priced by a signed oracle.';

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const { address, id } = await params;
  const result = await load(address, id, themeParam((await searchParams).t));
  if (!result) return { title: 'Trade not found — Whitespace' };

  const title = shareText(result.card);
  const image = { url: imagePath(address, id, result.theme), width: 1200, height: 630, alt: title };
  return {
    title: `${title} — Whitespace`,
    description: DESCRIPTION,
    openGraph: { title, description: DESCRIPTION, siteName: 'Whitespace', type: 'website', images: [image] },
    twitter: { card: 'summary_large_image', title, description: DESCRIPTION, images: [image.url] },
  };
}

export default async function SharePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { address, id } = await params;
  const result = await load(address, id, themeParam((await searchParams).t));
  if (!result) notFound();

  const title = shareText(result.card);
  return (
    <div className="share-page">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="share-image" src={imagePath(address, id, result.theme)} alt={title} width={1200} height={630} />
      <h1>{title}</h1>
      <p>Whitespace is a perpetuals exchange on Whitechain testnet. USDW is a test token with no value.</p>
      <div className="cta-row">
        <Link href="/trade" className="btn-primary">
          Trade on Whitespace
        </Link>
        <Link href="/" className="btn-secondary">
          What is this?
        </Link>
      </div>
    </div>
  );
}
