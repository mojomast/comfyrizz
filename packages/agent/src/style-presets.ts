/**
 * R2 step 5 (research §2.2 step 4): the six bundled looks as CPU/SVG thumbnails.
 *
 * The thumbnails are generated deterministically from the preset's own palette so
 * the Brief card can show the look *before* any GPU work: it is pure string SVG
 * (no model, no renderer, no network). GPU-rendered moodboards can replace these
 * later without changing the ids or the picker.
 */
import { STYLE_PRESET_DEFAULTS, STYLE_PRESETS, type StylePreset } from './brief.js';

export const STYLE_PRESET_LABELS: Record<StylePreset, string> = {
  clay: 'Clay',
  glass: 'Glass',
  'editorial-flat': 'Editorial flat',
  'isometric-tech': 'Isometric tech',
  'paper-cut': 'Paper cut',
  'cinematic-dark': 'Cinematic dark',
};

export interface StylePresetCard {
  id: StylePreset;
  label: string;
  palette: string[];
  font: string;
  attributes: string;
  /** Inline 160×90 SVG preview, safe to drop straight into the DOM. */
  thumbnail: string;
}

function svg(preset: StylePreset, body: string, background: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" width="160" height="90" role="img" aria-label="${preset} preset"><rect width="160" height="90" rx="8" fill="${background}"/>${body}</svg>`;
}

/** A distinct, deterministic mini-composition per preset. */
function thumbnailBody(preset: StylePreset): string {
  const [bg, a, b, c] = STYLE_PRESET_DEFAULTS[preset].palette;
  switch (preset) {
    case 'clay':
      return `<circle cx="52" cy="46" r="26" fill="${a}"/><circle cx="74" cy="52" r="18" fill="${b}" opacity="0.9"/><rect x="96" y="30" width="38" height="30" rx="14" fill="${a}" opacity="0.75"/><circle cx="120" cy="24" r="7" fill="${c}"/>`;
    case 'glass':
      return `<rect x="16" y="22" width="58" height="46" rx="10" fill="${a}" opacity="0.55"/><rect x="40" y="14" width="58" height="46" rx="10" fill="${b}" opacity="0.45"/><rect x="64" y="30" width="58" height="46" rx="10" fill="${c}" opacity="0.35"/><rect x="24" y="30" width="30" height="3" rx="1.5" fill="${c}" opacity="0.8"/>`;
    case 'editorial-flat':
      return `<rect x="14" y="18" width="70" height="54" fill="${a}"/><rect x="24" y="30" width="44" height="7" fill="${c}"/><rect x="24" y="44" width="60" height="4" fill="${b}" opacity="0.7"/><rect x="96" y="18" width="50" height="24" fill="${c}" opacity="0.85"/><rect x="96" y="48" width="50" height="24" fill="${b}" opacity="0.5"/>`;
    case 'isometric-tech':
      return `<path d="M80 16 L108 32 L80 48 L52 32 Z" fill="${a}" opacity="0.8"/><path d="M52 32 L80 48 L80 74 L52 58 Z" fill="${b}" opacity="0.7"/><path d="M108 32 L108 58 L80 74 L80 48 Z" fill="${c}" opacity="0.6"/><path d="M16 74 H48 M112 16 H144 M16 16 H40" stroke="${a}" stroke-width="2" opacity="0.5"/>`;
    case 'paper-cut':
      return `<path d="M0 62 Q40 44 80 60 T160 56 V90 H0 Z" fill="${a}"/><path d="M0 72 Q48 58 96 72 T160 66 V90 H0 Z" fill="${b}" opacity="0.92"/><path d="M0 82 Q56 72 112 82 T160 78 V90 H0 Z" fill="${c}" opacity="0.9"/><circle cx="36" cy="26" r="10" fill="${b}" opacity="0.85"/>`;
    case 'cinematic-dark':
      return `<defs><radialGradient id="cd" cx="0.5" cy="0.45" r="0.7"><stop offset="0" stop-color="${b}" stop-opacity="0.85"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#cd)"/><rect x="0" y="58" width="160" height="32" fill="${a}" opacity="0.75"/><rect x="20" y="40" width="54" height="5" rx="2.5" fill="${c}"/><rect x="20" y="50" width="34" height="3" rx="1.5" fill="${c}" opacity="0.6"/>`;
    default:
      return `<rect x="20" y="30" width="120" height="30" fill="${a}"/>`;
  }
}

/** The six picker cards, ready for the Brief card (or any list surface). */
export function stylePresets(): StylePresetCard[] {
  return STYLE_PRESETS.map(id => ({
    id,
    label: STYLE_PRESET_LABELS[id],
    palette: [...STYLE_PRESET_DEFAULTS[id].palette],
    font: STYLE_PRESET_DEFAULTS[id].font,
    attributes: STYLE_PRESET_DEFAULTS[id].attributes,
    thumbnail: svg(id, thumbnailBody(id), STYLE_PRESET_DEFAULTS[id].palette[0]),
  }));
}
