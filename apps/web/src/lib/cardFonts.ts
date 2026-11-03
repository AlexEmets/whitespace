import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The fonts the share cards are drawn in, for `next/og` (Satori) — shared by the trade card
 * and the stats card routes, so both images set the same type.
 */
export type CardFont = { name: string; data: Buffer; weight: 300 | 400 | 500; style: 'normal' };

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

let fonts: Promise<CardFont[]> | null = null;

export function loadCardFonts(): Promise<CardFont[]> {
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
