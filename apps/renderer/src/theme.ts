import { staticFile } from 'remotion';
import { loadFont } from '@remotion/fonts';
import type { PackageV1, Scene } from '../../../packages/schema/types';

/**
 * One design system (spec 6.9): a pinned local font, an 8px spacing scale, a type
 * scale and a small animation vocabulary. Nothing here reads the clock or network.
 */
export const FONT_FAMILY = 'Inter';

// Awaited by Remotion's delayRender before any measurement or still is taken.
void loadFont({
  family: FONT_FAMILY,
  url: staticFile('fonts/Inter-VariableFont_opsz,wght.ttf'),
  weight: '100 900',
  style: 'normal',
  display: 'block',
});

export const DEFAULT_PALETTE = ['#0d0f14', '#6d8cff', '#e6e8ee'] as const;

export function palette(pkg: PackageV1): string[] {
  const values = pkg.theme?.palette;
  if (!values || values.length < 2) return [...DEFAULT_PALETTE];
  return values.map((value, index) => value || DEFAULT_PALETTE[index % DEFAULT_PALETTE.length]);
}

export function color(colors: string[], index: number): string {
  return colors[index % colors.length] ?? DEFAULT_PALETTE[0];
}

/** Copy limits copied from the schema README/semantic layer: overflow is a fail state. */
export const COPY_LIMITS: Record<Scene['layout'], Partial<Record<string, number>>> = {
  title: { headline: 48, sub: 90 },
  hero: { headline: 64, sub: 120, body: 240 },
  stat: { headline: 48, sub: 90, body: 40 },
  chart: { headline: 64, sub: 120, footnote: 120 },
  list: { headline: 64, quote: 200, attribution: 80 },
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
  return `'${FONT_FAMILY}', system-ui, -apple-system, 'Segoe UI', sans-serif`;
}
