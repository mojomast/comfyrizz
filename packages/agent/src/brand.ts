/**
 * B1 (research §2.2 step 4 / §2.4): the brand kit.
 *
 * The kit rides in the package's existing `theme` — palette → `theme.palette`,
 * fonts → `theme.fonts[]` (each with its licence), and the uploaded logo → an
 * `origin: "upload"` asset referenced by `theme.logo_asset`. Nothing here needs
 * a schema change, and nothing here touches the network: validation, the font
 * licence check and the generation STYLE_BLOCK are all pure and testable.
 *
 * A font is only kept when it has a file *and* a known-safe licence; anything
 * missing or unsafe is dropped with a warning and the kit falls back to Inter,
 * which the renderer always bundles.
 */
import { z } from 'zod';
import { STYLE_PRESET_DEFAULTS, type StyleDraft, type StylePreset } from './brief.js';

export const BRAND_FALLBACK_FONT = 'Inter';
export const BRAND_MAX_PALETTE = 8;
export const BRAND_MAX_FONTS = 8;
export const BRAND_MAX_TONE = 3;

/** Licences a bundled web font can ship under. Missing or unknown → Inter. */
export const BRAND_SAFE_FONT_LICENSES = [
  'OFL-1.1', 'Apache-2.0', 'MIT', 'CC0-1.0', 'UFL-1.0', 'BSD-3-Clause', 'ISC', 'MPL-2.0',
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;
const ASSET_ID = /^a[A-Za-z0-9_-]{0,63}$/;

export const brandFontSchema = z.object({
  family: z.string().min(1).max(64).optional(),
  file: z.string().min(1).max(512).optional(),
  weight: z.number().int().min(100).max(900).optional(),
  license: z.string().min(1).max(128).optional(),
});
export type BrandFont = z.infer<typeof brandFontSchema>;

/** Lenient: the server accepts whatever the UI sends and normalises it. */
export const brandKitSchema = z.object({
  palette: z.array(z.string()).max(BRAND_MAX_PALETTE * 2).optional(),
  fonts: z.array(brandFontSchema).max(BRAND_MAX_FONTS * 2).optional(),
  tone: z.array(z.string().min(1).max(40)).max(BRAND_MAX_TONE).optional(),
  attributes: z.string().max(300).optional(),
  logo_asset: z.string().optional(),
});
export type BrandKitInput = z.infer<typeof brandKitSchema>;

/** A normalised kit: every colour is a lowercase #rrggbb, every font is safe. */
export interface BrandKit {
  palette: string[];
  fonts: Array<Required<Pick<BrandFont, 'family' | 'file' | 'license'>> & Pick<BrandFont, 'weight'>>;
  tone: string[];
  attributes: string;
  logo_asset?: string;
}

export interface BrandWarning {
  code:
    | 'BRAND_PALETTE_INVALID'
    | 'BRAND_PALETTE_TRUNCATED'
    | 'BRAND_FONT_INVALID'
    | 'BRAND_FONT_UNSAFE_LICENSE'
    | 'BRAND_FONT_DUPLICATE'
    | 'BRAND_FONT_TRUNCATED'
    | 'BRAND_LOGO_INVALID';
  field: string;
  message: string;
}

/** The bundled theme mapping a normalised kit writes into a package. */
export interface BrandTheme {
  palette?: string[];
  font?: string;
  fonts?: Array<{ family: string; file: string; weight?: number; license: { id: string } }>;
  logo_asset?: string;
}

/** A font family is usable only when it can ship: a file and a known-safe licence. */
export function isSafeFontLicense(license?: string): boolean {
  return license !== undefined && (BRAND_SAFE_FONT_LICENSES as readonly string[]).includes(license);
}

export function effectiveFont(kit: Partial<BrandKit> = {}): string {
  return kit.fonts?.find(font => font.file && isSafeFontLicense(font.license))?.family ?? BRAND_FALLBACK_FONT;
}

/**
 * Validate and normalise raw brand-kit input. Always returns a kit (possibly
 * empty) plus the warnings the UI should surface; never throws on bad input.
 */
export function normalizeBrandKit(input: BrandKitInput | Record<string, unknown> | null | undefined): { kit: BrandKit; warnings: BrandWarning[] } {
  const raw = (input ?? {}) as BrandKitInput;
  const warnings: BrandWarning[] = [];

  const palette: string[] = [];
  for (const [index, value] of (Array.isArray(raw.palette) ? raw.palette : []).entries()) {
    const hex = String(value ?? '').trim();
    if (!HEX.test(hex)) {
      warnings.push({ code: 'BRAND_PALETTE_INVALID', field: `palette[${index}]`, message: `"${hex}" is not a #rrggbb colour; dropped` });
      continue;
    }
    if (palette.length >= BRAND_MAX_PALETTE) {
      warnings.push({ code: 'BRAND_PALETTE_TRUNCATED', field: `palette[${index}]`, message: `more than ${BRAND_MAX_PALETTE} colours; dropped` });
      continue;
    }
    const lower = hex.toLowerCase();
    if (!palette.includes(lower)) palette.push(lower);
  }

  const fonts: BrandKit['fonts'] = [];
  for (const [index, value] of (Array.isArray(raw.fonts) ? raw.fonts : []).entries()) {
    const font = value ?? {};
    const family = String(font.family ?? '').trim();
    if (!family) {
      warnings.push({ code: 'BRAND_FONT_INVALID', field: `fonts[${index}]`, message: 'missing family; dropped' });
      continue;
    }
    if (!font.file) {
      warnings.push({ code: 'BRAND_FONT_INVALID', field: `fonts[${index}]`, message: `${family} has no font file; falling back to ${BRAND_FALLBACK_FONT}` });
      continue;
    }
    if (!isSafeFontLicense(font.license)) {
      warnings.push({
        code: 'BRAND_FONT_UNSAFE_LICENSE',
        field: `fonts[${index}].license`,
        message: `${family} uses ${font.license ? `unsafe licence "${font.license}"` : 'no licence'}; falling back to ${BRAND_FALLBACK_FONT}`,
      });
      continue;
    }
    if (fonts.some(existing => existing.family.toLowerCase() === family.toLowerCase())) {
      warnings.push({ code: 'BRAND_FONT_DUPLICATE', field: `fonts[${index}]`, message: `${family} is already in the kit; dropped` });
      continue;
    }
    if (fonts.length >= BRAND_MAX_FONTS) {
      warnings.push({ code: 'BRAND_FONT_TRUNCATED', field: `fonts[${index}]`, message: `more than ${BRAND_MAX_FONTS} fonts; dropped` });
      continue;
    }
    fonts.push({
      family,
      file: font.file,
      license: font.license as string,
      ...(font.weight !== undefined ? { weight: font.weight } : {}),
    });
  }

  const tone: string[] = [];
  for (const value of (Array.isArray(raw.tone) ? raw.tone : []).slice(0, BRAND_MAX_TONE)) {
    const word = String(value ?? '').trim();
    if (word) tone.push(word);
  }

  let logo_asset = String(raw.logo_asset ?? '').trim();
  if (logo_asset && !ASSET_ID.test(logo_asset)) {
    warnings.push({ code: 'BRAND_LOGO_INVALID', field: 'logo_asset', message: `"${logo_asset}" is not an asset id (must start with "a"); dropped` });
    logo_asset = '';
  }

  return {
    kit: {
      palette,
      fonts,
      tone,
      attributes: String(raw.attributes ?? '').trim(),
      ...(logo_asset ? { logo_asset } : {}),
    },
    warnings,
  };
}

/** Map a normalised kit to a package `theme` fragment. Omitted keys keep the old theme. */
export function brandTheme(kit: Partial<BrandKit> = {}): BrandTheme {
  const fonts = (kit.fonts ?? []).filter(font => font.file && isSafeFontLicense(font.license));
  return {
    ...(kit.palette?.length ? { palette: kit.palette } : {}),
    ...(fonts.length
      ? {
          font: fonts[0]!.family,
          fonts: fonts.map(font => ({
            family: font.family,
            file: font.file,
            ...(font.weight !== undefined ? { weight: font.weight } : {}),
            license: { id: font.license },
          })),
        }
      : {}),
    ...(kit.logo_asset ? { logo_asset: kit.logo_asset } : {}),
  };
}

/** Merge a kit into a package's theme without mutating the input. */
export function applyBrandKit<T extends { theme?: Record<string, unknown> }>(pkg: T, kit: Partial<BrandKit> = {}): T {
  return { ...pkg, theme: { ...(pkg.theme ?? {}), ...brandTheme(kit) } };
}

/** The style pieces the brief/outline use; a brand kit's palette and font win. */
export function brandBriefStyle(style: StyleDraft = {}, kit: Partial<BrandKit> = {}): Required<Pick<StyleDraft, 'preset'>> & StyleDraft {
  const preset: StylePreset = style.preset ?? 'cinematic-dark';
  const defaults = STYLE_PRESET_DEFAULTS[preset];
  return {
    preset,
    palette: style.palette ?? (kit.palette?.length ? kit.palette : defaults.palette),
    font: style.font ?? effectiveFont(kit),
    attributes: style.attributes ?? (kit.attributes || defaults.attributes),
    ...(style.references ? { references: style.references } : {}),
  };
}

/**
 * The per-package generation STYLE_BLOCK (research §1.5). It is chosen once from
 * the look + brand kit and reused for every image job, so a run does not drift
 * from the owner's palette.
 */
export function brandStyleBlock(preset: StylePreset, kit: Partial<BrandKit> = {}): string {
  const defaults = STYLE_PRESET_DEFAULTS[preset];
  const attributes = (kit.attributes?.trim() || defaults.attributes).replace(/[.;]+$/, '');
  const palette = (kit.palette?.length ? kit.palette : defaults.palette).join(', ');
  return `${attributes.charAt(0).toUpperCase()}${attributes.slice(1)}; palette ${palette}; every surface is blank and unmarked.`;
}
