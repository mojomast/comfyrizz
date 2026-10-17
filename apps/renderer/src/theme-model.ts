import type { PackageV1 } from '../../../packages/schema/types';

/**
 * Pure colour helpers, split out of `theme.ts` so they can be unit-tested in
 * Node without loading Remotion's font/browser shims.
 */
export const DEFAULT_PALETTE = ['#0d0f14', '#6d8cff', '#e6e8ee'] as const;

export function palette(pkg: PackageV1): string[] {
  const values = pkg.theme?.palette;
  if (!values || values.length < 2) return [...DEFAULT_PALETTE];
  return values.map((value, index) => value || DEFAULT_PALETTE[index % DEFAULT_PALETTE.length]);
}

export function color(colors: string[], index: number): string {
  return colors[index % colors.length] ?? DEFAULT_PALETTE[0];
}

function parseHex(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/** A colour is safe for text when it is a plain opaque hex, never `transparent`/`none`. */
export function isOpaqueColor(value: unknown): value is string {
  return parseHex(value) !== null;
}

/** Pick a readable text colour for a swatch, independent of `palette[0]`. */
export function contrastText(value: unknown): string {
  const rgb = parseHex(value);
  if (!rgb) return '#0d0f14';
  const [r, g, b] = rgb;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#0d0f14' : '#f7f9fc';
}

/**
 * P-fix1: text colours are independent of `palette[0]`, which may be a dark or
 * media-matching base (or even `transparent`). The proposed H-fix1 theme tokens
 * win when present; the defaults keep every existing 4-colour package identical.
 */
export function textColors(pkg: PackageV1): { primary: string; muted: string; onAccent: string } {
  const colors = palette(pkg);
  const theme = pkg.theme as (PackageV1['theme'] & { text?: string; text_muted?: string; text_on_accent?: string }) | undefined;
  const primary = isOpaqueColor(colors[3]) ? colors[3] : contrastText(colors[0]);
  const muted = isOpaqueColor(colors[2]) ? colors[2] : primary;
  const themed = (value: unknown, fallback: string) => (isOpaqueColor(value) ? value : fallback);
  return {
    primary: themed(theme?.text, primary),
    muted: themed(theme?.text_muted, muted),
    onAccent: themed(theme?.text_on_accent, isOpaqueColor(colors[0]) ? colors[0] : contrastText(colors[2])),
  };
}
