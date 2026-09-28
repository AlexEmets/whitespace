import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { CARD_HEIGHT, CARD_WIDTH, ShareCardImage } from '@/components/share/ShareCardImage';
import { apiFetchJson, loadShareCard } from '@/lib/shareData';

/**
 * GET /share/:address/:id/card.png — the PnL card as a PNG: the image X and Telegram show
 * for a share link, and the file the share dialog downloads. Every figure is read from
 * the API by `loadShareCard`; nothing in the URL but the address, id and theme is trusted.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Font = { name: string; data: Buffer; weight: 300 | 400 | 500; style: 'normal' };

/* Static TTF cuts committed under src/assets/fonts (Satori cannot read the woff2 the site
   itself loads). `next start` runs from apps/web; the second root covers a server started
   from the repository root. */
const FONT_ROOTS = [join(process.cwd(), 'src/assets/fonts'), join(process.cwd(), 'apps/web/src/assets/fonts')];

async function readFont(file: string): Promise<Buffer> {
  let lastError: unknown;
  for (const root of FONT_ROOTS) {
    try {
      return await readFile(join(root, file));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

let fonts: Promise<Font[]> | null = null;

function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all([
    readFont('Geologica-Light.ttf'),
    readFont('Geologica-Medium.ttf'),
    readFont('AzeretMono-Regular.ttf'),
    readFont('AzeretMono-Medium.ttf'),
  ]).then(([geoLight, geoMedium, monoRegular, monoMedium]) => [
    { name: 'Geologica', data: geoLight, weight: 300, style: 'normal' },
    { name: 'Geologica', data: geoMedium, weight: 500, style: 'normal' },
    { name: 'Azeret Mono', data: monoRegular, weight: 400, style: 'normal' },
    { name: 'Azeret Mono', data: monoMedium, weight: 500, style: 'normal' },
  ]);
  // A failed read must not be cached forever.
  fonts.catch(() => {
    fonts = null;
  });
  return fonts;
}

export async function GET(request: Request, { params }: { params: Promise<{ address: string; id: string }> }) {
  const { address, id } = await params;
  const theme = new URL(request.url).searchParams.get('t');
  const result = await loadShareCard({ address, id, theme }, apiFetchJson());
  if (!result) return new Response('Not found', { status: 404 });

  return new ImageResponse(<ShareCardImage card={result.card} theme={result.theme} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: await loadFonts(),
    headers: {
      // A close never changes; an open position is a snapshot at the mark.
      'Cache-Control': result.card.status === 'closed' ? 'public, max-age=3600, s-maxage=86400' : 'public, max-age=60',
    },
  });
}
