import { createContext, useContext } from 'react';
import { staticFile } from 'remotion';
import { loadFont } from '@remotion/fonts';
import type { Scene, PackageV1 } from '../../../packages/schema/types';
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_PALETTE,
  brandFontEntries,
  brandFontFamily,
  color,
  palette,
  textColors,
} from './theme-model.js';

export { DEFAULT_PALETTE, color, palette, textColors, brandFontEntries, brandFontFamily };

/**
 * One design system (spec 6.9): a pinned local font, an 8px spacing scale, a type
 * scale and a small animation vocabulary. Nothing here reads the clock or network.
 *
 * B1: `Inter` is always bundled; a package's brand fonts are loaded on top and
 * its first declared family becomes the typeset family for the whole run.
 */
export const FONT_FAMILY = DEFAULT_FONT_FAMILY;

// Awaited by Remotion's delayRender before any measurement or still is taken.
void loadFont({
  family: FONT_FAMILY,
  url: staticFile('fonts/Inter-Variable.ttf'),
  weight: '100 900',
  style: 'normal',
  display: 'block',
});

/** Copy limits copied from the schema README/semantic layer: overflow is a fail state. */
export const COPY_LIMITS: Record<Scene['layout'], Partial<Record<string, number>>> = {
  title: { headline: 48, sub: 90 },
  hero: { headline: 64, sub: 120, body: 240 },
  stat: { headline: 48, sub: 90, body: 40 },
  chart: { headline: 64, sub: 120, footnote: 120 },
  list: { headline: 64, quote: 200, attribution: 80 },
  split: { headline: 48, sub: 90 },
  compare: { headline: 48, sub: 90 },
  code: { headline: 64 },
};

/** The exact spec text of a fade default, kept here so the renderer never guesses. */
export const DEFAULT_TRANSITION = { type: 'fade' as const, frames: 15 };

export const TYPE_SCALE = {
  kicker: 28,
  headlineXl: 104,
  headlineLg: 76,
  headlineMd: 60,
  sub: 34,
  body: 28,
  stat: 192,
  footnote: 22,
} as const;

export const SAFE_AREA = { x: 144, y: 96 } as const;

export function fontFamily(): string {
  return fontStack(FONT_FAMILY);
}

/** The CSS family stack: the brand face first, then the bundled Inter and system faces. */
export function fontStack(family: string): string {
  const brand = family && family !== FONT_FAMILY ? `'${family}', ` : '';
  return `${brand}'${FONT_FAMILY}', system-ui, -apple-system, 'Segoe UI', sans-serif`;
}

/** Shared with `TimelinePlayer`; a scene reads it to typeset with the brand face. */
export const FontFamilyContext = createContext<string>(FONT_FAMILY);

export function useFontFamily(): string {
  return fontStack(useContext(FontFamilyContext));
}

const loadedBrandFonts = new Set<string>();

/**
 * B1: load each declared brand font once. `loadFont` holds a Remotion
 * `delayRender` until the face is ready, so measuring and stills never race the
 * download. A missing file makes Remotion fail loudly rather than fall back
 * silently.
 */
export function ensureBrandFonts(pkg?: PackageV1, previewSources?: Record<string, string> | null): void {
  for (const font of brandFontEntries(pkg as PackageV1)) {
    // In the web Player a package path is not public: wait for its authenticated
    // blob instead of requesting it from the static web server.
    const url = previewSources == null ? staticFile(font.file) : previewSources[font.file];
    if (!url) continue;
    const key = `${font.family}:${url}:${font.weight ?? ''}`;
    if (loadedBrandFonts.has(key)) continue;
    loadedBrandFonts.add(key);
    void loadFont({
      family: font.family,
      url,
      ...(previewSources == null ? {} : { format: 'truetype' as const }),
      weight: String(font.weight ?? '400'),
      display: 'block',
    });
  }
}
