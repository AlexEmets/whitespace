import { ImageResponse } from 'next/og';
import { CARD_HEIGHT, CARD_WIDTH } from '@/components/share/ShareCardImage';
import { StatsCardImage } from '@/components/share/StatsCardImage';
import { loadCardFonts } from '@/lib/cardFonts';
import { apiFetchJson, loadStatsCard } from '@/lib/shareData';

/**
 * GET /share/:address/stats/card.png — a wallet's stats card as a PNG: the preview X and
 * Telegram show for a stats link, and the file the share dialog downloads. The record is
 * read from the API by `loadStatsCard`; only the address and the theme come from the URL.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const theme = new URL(request.url).searchParams.get('t');
  const result = await loadStatsCard({ address, theme }, apiFetchJson());
  if (!result) return new Response('Not found', { status: 404 });

  return new ImageResponse(<StatsCardImage card={result.card} theme={result.theme} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: await loadCardFonts(),
    // A record moves with every close: short-lived, so a fresh link shows a fresh card.
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
