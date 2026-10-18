/**
 * Pure colour helpers, split out of `theme.ts` so they can be unit-tested on
 * plain Node (20+) without loading Remotion's font/browser shims.
 *
 * @typedef {import('../../../packages/schema/types').PackageV1} PackageV1
 * @typedef {{ primary: string, muted: string, onAccent: string }} TextColors
 */

/** @type {readonly string[]} */
export const DEFAULT_PALETTE = ['#0d0f14', '#6d8cff', '#e6e8ee'];

/** B1: the bundled fallback face; matches the Inter loaded by `theme.ts`. */
export const DEFAULT_FONT_FAMILY = 'Inter';

/**
 * @param {PackageV1} pkg
 * @returns {string[]}
 */
export function palette(pkg) {
  const values = pkg.theme?.palette;
  if (!values || values.length < 2) return [...DEFAULT_PALETTE];
  return values.map((value, index) => value || DEFAULT_PALETTE[index % DEFAULT_PALETTE.length]);
}

/**
 * @param {string[]} colors
 * @param {number} index
 * @returns {string}
 */
export function color(colors, index) {
  return colors[index % colors.length] ?? DEFAULT_PALETTE[0];
}

/**
 * @param {unknown} value
 * @returns {[number, number, number] | null}
 */
function parseHex(value) {
  if (typeof value !== 'string') return null;
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/**
 * A colour is safe for text when it is a plain opaque hex, never `transparent`/`none`.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOpaqueColor(value) {
  return parseHex(value) !== null;
}

/**
 * Pick a readable text colour for a swatch, independent of `palette[0]`.
 * @param {unknown} value
 * @returns {string}
 */
export function contrastText(value) {
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
 * @param {PackageV1} pkg
 * @returns {TextColors}
 */
export function textColors(pkg) {
  const colors = palette(pkg);
  const theme = /** @type {{ text?: string, text_muted?: string, text_on_accent?: string } | undefined} */ (pkg.theme);
  const primary = isOpaqueColor(colors[3]) ? colors[3] : contrastText(colors[0]);
  const muted = isOpaqueColor(colors[2]) ? colors[2] : primary;
  const themed = (/** @type {unknown} */ value, /** @type {string} */ fallback) => (isOpaqueColor(value) ? value : fallback);
  return {
    primary: themed(theme?.text, primary),
    muted: themed(theme?.text_muted, muted),
    onAccent: themed(theme?.text_on_accent, isOpaqueColor(colors[0]) ? colors[0] : contrastText(colors[2])),
  };
}

/**
 * B1: the brand fonts a package declares, in order. A font only counts when it
 * has both a family and a file; the kit's licence check already dropped the
 * rest, so anything here is safe to load.
 * @param {PackageV1} pkg
 * @returns {Array<{ family: string, file: string, weight?: number }>}
 */
export function brandFontEntries(pkg) {
  const fonts = pkg?.theme?.fonts;
  if (!Array.isArray(fonts)) return [];
  const entries = [];
  for (const font of fonts) {
    if (!font || typeof font.family !== 'string' || !font.family.trim()) continue;
    if (typeof font.file !== 'string' || !font.file.trim()) continue;
    entries.push({
      family: font.family.trim(),
      file: font.file.trim(),
      ...(typeof font.weight === 'number' ? { weight: font.weight } : {}),
    });
  }
  return entries;
}

/**
 * B1: the family the renderer should typeset with — the first declared brand
 * font, or `theme.font` when it has no file (Inter is always bundled), or Inter.
 * @param {PackageV1} pkg
 * @returns {string}
 */
export function brandFontFamily(pkg) {
  const first = brandFontEntries(pkg)[0];
  if (first) return first.family;
  const font = pkg?.theme?.font;
  return typeof font === 'string' && font.trim() ? font.trim() : DEFAULT_FONT_FAMILY;
}
