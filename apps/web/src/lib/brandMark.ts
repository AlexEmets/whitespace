/**
 * Geometry of the brand mark, the "diamond ring": an eclipsed disc whose corona breaks
 * into one bright point on the rim — the instant before totality, when a solar eclipse is
 * at its most recognisable.
 *
 * One set of numbers for every place the mark is drawn: the header's inline SVG
 * (components/BrandMark.tsx), the PnL share card (share/ShareCardImage.tsx) and the tab
 * icon (app/icon.svg, which is static and so copies these by hand). All on a 64-unit
 * square.
 */
export const BRAND_VIEWBOX = 64;

/** The eclipsed disc; its stroke is the corona's rim. */
export const BRAND_DISC = { cx: 32, cy: 32, r: 19 } as const;

/** The soft corona around the disc — a radial gradient that peaks just outside the rim. */
export const BRAND_GLOW = { cx: 32, cy: 32, r: 30 } as const;

/** The halo of the flare, centred on the rim at 45° up and to the right. */
export const BRAND_FLARE = { cx: 45.4, cy: 18.6, r: 8 } as const;

/** The flare itself: a thin four-pointed star over the halo. */
export const BRAND_STAR_PATH = 'M45.4 11.2 L46.3 17.7 L52.8 18.6 L46.3 19.5 L45.4 26 L44.5 19.5 L38 18.6 L44.5 17.7 Z';
