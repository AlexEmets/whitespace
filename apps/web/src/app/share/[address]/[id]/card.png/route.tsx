import { ImageResponse } from 'next/og';
import { CARD_HEIGHT, CARD_WIDTH, ShareCardImage } from '@/components/share/ShareCardImage';
import { loadCardFonts } from '@/lib/cardFonts';
import { apiFetchJson, loadShareCard } from '@/lib/shareData';

/**
 * GET /share/:address/:id/card.png — the PnL card as a PNG: the image X and Telegram show
 * for a share link, and the file the share dialog downloads. Every figure is read from
 * the API by `loadShareCard`; nothing in the URL but the address, id and theme is trusted.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ address: string; id: string }> }) {
  const { address, id } = await params;
  const theme = new URL(request.url).searchParams.get('t');
  const result = await loadShareCard({ address, id, theme }, apiFetchJson());
  if (!result) return new Response('Not found', { status: 404 });

  return new ImageResponse(<ShareCardImage card={result.card} theme={result.theme} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: await loadCardFonts(),
    headers: {
      // A close never changes; an open position is a snapshot at the mark.
      'Cache-Control': result.card.status === 'closed' ? 'public, max-age=3600, s-maxage=86400' : 'public, max-age=60',
    },
  });
}
