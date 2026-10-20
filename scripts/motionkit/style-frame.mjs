// MOTION-UPGRADE M12: deterministic SVG style frames.
//
// styleFrame(recipe, { width, height, text }) renders a self-contained SVG
// preview of a comfyrizz.recipe/v1 look: the procedural background pattern,
// palette blocks, a headline in the display font (font-family attribute only,
// no CSS @font-face or external loads), a CSS/SVG version of the recipe's
// first finish effect (feTurbulence grain, radial vignette, scanline pattern,
// duotone feColorMatrix, ...) and a glyph for the primary transition.
//
// Pure module: no side effects at import time, no filesystem writes, no
// network, no clock and no randomness. Every value is derived from the recipe
// and the options, so the same input always yields the same bytes. The only
// URL in the output is the SVG namespace. Freezes the palette/transition
// vocabularies to recipe-schema and derives font family names from the asset
// manifest instead of copying them.

import assetsData from "./data/assets.json" with { type: "json" };
import { BACKGROUND_PATTERNS } from "./recipe-schema.mjs";

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const HEX = /^#[0-9a-fA-F]{6}$/;

const FALLBACK_PALETTE = Object.freeze({
  background: "#15171c",
  text: "#f2f2f0",
  accent: "#e2513a",
  muted: "#8a8f98",
});

/** Transition glyph design box; glyphs are scaled into the frame slot. */
const GLYPH_BOX = Object.freeze({ w: 60, h: 28 });

/** Rendered kind per finish effect id. Unknown ids fall back to "grain". */
export const FINISH_KIND_BY_ID = Object.freeze({
  "film-grain": "grain",
  "grain-fine": "grain",
  "paper-grain": "grain",
  "paper-texture": "grain",
  "dust-scratches": "grain",
  "boil-line": "grain",
  halftone: "halftone",
  "pixelate-in": "halftone",
  "vignette-soft": "vignette",
  "vignette-hard": "vignette",
  "depth-blur": "vignette",
  scanlines: "scanlines",
  "scanlines-soft": "scanlines",
  "crt-curve": "scanlines",
  "vhs-tracking": "scanlines",
  duotone: "duotone",
  "mono-grade": "duotone",
  "sepia-grade": "duotone",
  "teal-orange": "duotone",
  lut: "duotone",
  "chroma-shift": "chroma",
  "glitch-slice": "chroma",
  "riso-misregister": "chroma",
  "light-leak": "glow",
  halation: "glow",
  bloom: "glow",
  "glow-text": "glow",
  "soft-glow": "glow",
  "chrome-sheen": "glow",
  "motion-smear": "smear",
  "hard-shadow": "shadow",
  "drop-shadow": "shadow",
  "soft-shadow": "shadow",
});

/** Per-kind parameter specs: [min, max, default] (ranges mirror effects.json). */
export const FINISH_PARAM_SPECS = Object.freeze({
  grain: Object.freeze({ amount: [0, 1, 0.12], size: [0.5, 8, 2] }),
  halftone: Object.freeze({ dotSize: [0.5, 8, 2], angle: [0, 360, 45] }),
  vignette: Object.freeze({ amount: [0, 1, 0.4], radius: [0.1, 1, 0.6] }),
  scanlines: Object.freeze({ count: [20, 600, 240], opacity: [0, 1, 0.35] }),
  duotone: Object.freeze({ amount: [0, 1, 0.9] }),
  chroma: Object.freeze({ offset: [0, 12, 3] }),
  glow: Object.freeze({ intensity: [0, 1, 0.5] }),
  smear: Object.freeze({ amount: [0, 30, 6] }),
  shadow: Object.freeze({ offset: [0, 40, 8], opacity: [0, 1, 0.5] }),
});

/** Which finish kinds need a filter on the whole frame instead of an overlay. */
const GRADED_KINDS = new Set(["duotone", "chroma", "smear"]);

const FONT_NAMES = buildFontNames();

function buildFontNames() {
  const names = new Map();
  const fonts = assetsData && Array.isArray(assetsData.fonts) ? assetsData.fonts : [];
  for (const font of fonts) {
    if (font && typeof font.id === "string" && typeof font.name === "string" && font.name) {
      names.set(font.id, font.name);
    }
  }
  return names;
}

function titleCase(id) {
  return id
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** CSS font-family name for a recipe font id (manifest name, else title case). */
export function fontFamilyOf(fontId) {
  if (typeof fontId !== "string" || fontId.length === 0) return "sans-serif";
  return FONT_NAMES.get(fontId) ?? titleCase(fontId);
}

/** Finish effect id -> rendered kind (grain | vignette | scanlines | duotone | ...). */
export function finishKindOf(effectId) {
  return FINISH_KIND_BY_ID[String(effectId ?? "")] ?? "grain";
}

/** Escape text for XML text nodes and double-quoted attribute values. */
export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function num(value) {
  const n = Math.round(value * 100) / 100;
  return Object.is(n, -0) ? "0" : String(n);
}

function int(value) {
  return String(Math.round(value));
}

function dim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(4096, Math.max(64, Math.round(n)));
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

/** FNV-1a over a string; stable across runs and platforms. */
function hashSeed(text) {
  let h = 2166136261 >>> 0;
  const str = String(text);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function hexToUnit(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = hexToUnit(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readPalette(palette) {
  const colors = [];
  const byRole = new Map();
  if (Array.isArray(palette)) {
    for (const entry of palette) {
      if (!entry || typeof entry !== "object") continue;
      const hex = typeof entry.hex === "string" && HEX.test(entry.hex) ? entry.hex.toLowerCase() : null;
      if (!hex) continue;
      colors.push(hex);
      if (typeof entry.role === "string" && !byRole.has(entry.role)) byRole.set(entry.role, hex);
    }
  }
  if (colors.length === 0) {
    colors.push(FALLBACK_PALETTE.background, FALLBACK_PALETTE.text, FALLBACK_PALETTE.accent, FALLBACK_PALETTE.muted);
  }
  const background = byRole.get("background") ?? colors[0];
  const text = byRole.get("text") ?? colors[1] ?? FALLBACK_PALETTE.text;
  const accent = byRole.get("accent") ?? colors[2] ?? FALLBACK_PALETTE.accent;
  const muted = byRole.get("muted") ?? FALLBACK_PALETTE.muted;
  const extras = colors.filter((hex) => hex !== background && hex !== accent);
  const extra = extras[0] ?? muted;
  return { colors, background, text, accent, muted, extra };
}

function firstFinish(finish) {
  if (!Array.isArray(finish) || finish.length === 0) return { id: "", params: {} };
  const first = finish[0];
  if (typeof first === "string") return { id: first, params: {} };
  if (first && typeof first === "object") {
    const params = first.params && typeof first.params === "object" && !Array.isArray(first.params) ? first.params : {};
    return { id: typeof first.id === "string" ? first.id : "", params };
  }
  return { id: "", params: {} };
}

function resolveFinishParams(kind, provided) {
  const specs = FINISH_PARAM_SPECS[kind] ?? FINISH_PARAM_SPECS.grain;
  const out = {};
  for (const [name, [min, max, dflt]] of Object.entries(specs)) {
    const raw = provided ? provided[name] : undefined;
    const n = typeof raw === "number" && Number.isFinite(raw) ? raw : dflt;
    out[name] = Math.min(max, Math.max(min, n));
  }
  return out;
}

function primaryTransition(transitions) {
  if (transitions && typeof transitions === "object" && typeof transitions.primary === "string" && transitions.primary) {
    return transitions.primary;
  }
  return "cut";
}

function duotoneMatrix(shadowHex, highlightHex, amount) {
  const [sr, sg, sb] = hexToUnit(shadowHex);
  const [hr, hg, hb] = hexToUnit(highlightHex);
  const dr = hr - sr;
  const dg = hg - sg;
  const db = hb - sb;
  const t = clampUnit(amount);
  const mix = (ident, duo) => ident * (1 - t) + duo * t;
  const rows = [
    [mix(1, dr * 0.2126), mix(0, dr * 0.7152), mix(0, dr * 0.0722), 0, mix(0, sr)],
    [mix(0, dg * 0.2126), mix(1, dg * 0.7152), mix(0, dg * 0.0722), 0, mix(0, sg)],
    [mix(0, db * 0.2126), mix(0, db * 0.7152), mix(1, db * 0.0722), 0, mix(0, sb)],
    [0, 0, 0, 1, 0],
  ];
  return rows.map((row) => row.map(num).join(" ")).join(" ");
}

function backgroundPatternMarkup(pattern, palette, ids, seed, width, height) {
  const { background, accent, extra, muted } = palette;

  if (pattern === "grid") {
    return [
      `<rect width="${int(width)}" height="${int(height)}" fill="url(#${ids.bgGrid})"/>`,
    ];
  }
  if (pattern === "dots") {
    return [
      `<rect width="${int(width)}" height="${int(height)}" fill="url(#${ids.bgDots})"/>`,
    ];
  }
  if (pattern === "grain") {
    return [
      `<rect width="${int(width)}" height="${int(height)}" fill="${background}"/>`,
      `<rect width="${int(width)}" height="${int(height)}" filter="url(#${ids.bgGrain})" opacity="0.45"/>`,
    ];
  }
  if (pattern === "mesh") {
    const blobs = [
      { id: ids.bgMeshA, color: accent, s: hashSeed(`${ids.slug}:mesh:1`) },
      { id: ids.bgMeshB, color: extra, s: hashSeed(`${ids.slug}:mesh:2`) },
      { id: ids.bgMeshC, color: muted, s: hashSeed(`${ids.slug}:mesh:3`) },
    ];
    const out = [`<rect width="${int(width)}" height="${int(height)}" fill="${background}"/>`];
    for (const blob of blobs) {
      const cx = Math.round(width * (0.15 + (blob.s % 70) / 100));
      const cy = Math.round(height * (0.1 + ((blob.s >> 5) % 80) / 100));
      const rx = Math.round(width * 0.3);
      const ry = Math.round(height * 0.4);
      out.push(
        `<ellipse cx="${int(cx)}" cy="${int(cy)}" rx="${int(rx)}" ry="${int(ry)}" fill="url(#${blob.id})"/>`,
      );
    }
    return out;
  }
  // gradient (default)
  return [`<rect width="${int(width)}" height="${int(height)}" fill="url(#${ids.bgGradient})"/>`];
}

function backgroundDefs(pattern, palette, ids, bits) {
  const { background, accent, extra } = palette;
  const defs = [];
  if (pattern === "gradient") {
    defs.push(
      `<linearGradient id="${ids.bgGradient}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100%" y2="100%">` +
        `<stop offset="0" stop-color="${accent}" stop-opacity="0.85"/>` +
        `<stop offset="0.5" stop-color="${extra}" stop-opacity="0.7"/>` +
        `<stop offset="1" stop-color="${background}"/>` +
        `</linearGradient>`,
    );
  }
  if (pattern === "grid") {
    const cell = Math.max(8, Math.round(bits.cell));
    defs.push(
      `<pattern id="${ids.bgGrid}" width="${int(cell)}" height="${int(cell)}" patternUnits="userSpaceOnUse">` +
        `<path d="M${int(cell)} 0 V${int(cell)} H0" fill="none" stroke="${palette.text}" stroke-width="1" opacity="0.18"/>` +
        `</pattern>`,
    );
  }
  if (pattern === "dots") {
    const cell = Math.max(8, Math.round(bits.cell));
    defs.push(
      `<pattern id="${ids.bgDots}" width="${int(cell)}" height="${int(cell)}" patternUnits="userSpaceOnUse">` +
        `<circle cx="${int(cell / 2)}" cy="${int(cell / 2)}" r="${num(Math.max(1, cell * 0.09))}" fill="${accent}" opacity="0.55"/>` +
        `</pattern>`,
    );
  }
  if (pattern === "grain") {
    defs.push(
      `<filter id="${ids.bgGrain}" x="0%" y="0%" width="100%" height="100%">` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" seed="${int(bits.grain)}" result="n"/>` +
        `<feColorMatrix in="n" type="saturate" values="0"/>` +
        `</filter>`,
    );
  }
  if (pattern === "mesh") {
    const stops = [
      { id: ids.bgMeshA, color: accent },
      { id: ids.bgMeshB, color: extra },
      { id: ids.bgMeshC, color: palette.muted },
    ];
    for (const stop of stops) {
      defs.push(
        `<radialGradient id="${stop.id}" cx="50%" cy="50%" r="50%">` +
          `<stop offset="0" stop-color="${stop.color}" stop-opacity="0.8"/>` +
          `<stop offset="1" stop-color="${stop.color}" stop-opacity="0"/>` +
          `</radialGradient>`,
      );
    }
  }
  return defs;
}

function finishDefs(kind, params, ids, bits, width, height, palette) {
  const defs = [];
  if (kind === "grain") {
    const bf = num(0.9 / params.size);
    defs.push(
      `<filter id="${ids.finish}" x="0%" y="0%" width="100%" height="100%">` +
        `<feTurbulence type="fractalNoise" baseFrequency="${bf}" numOctaves="3" seed="${int(bits.grain)}" result="n"/>` +
        `<feColorMatrix in="n" type="saturate" values="0"/>` +
        `</filter>`,
    );
  }
  if (kind === "vignette") {
    defs.push(
      `<radialGradient id="${ids.finish}" cx="50%" cy="50%" r="70%">` +
        `<stop offset="${num(clampUnit(params.radius))}" stop-color="#000000" stop-opacity="0"/>` +
        `<stop offset="1" stop-color="#000000" stop-opacity="${num(params.amount)}"/>` +
        `</radialGradient>`,
    );
  }
  if (kind === "scanlines") {
    const spacing = Math.min(16, Math.max(2, Math.round((height * 2) / params.count)));
    defs.push(
      `<pattern id="${ids.finish}" width="${int(width)}" height="${int(spacing)}" patternUnits="userSpaceOnUse">` +
        `<rect width="${int(width)}" height="1" fill="#000000" fill-opacity="${num(params.opacity)}"/>` +
        `</pattern>`,
    );
  }
  if (kind === "halftone") {
    const cell = Math.max(3, Math.round(params.dotSize * 2.2));
    defs.push(
      `<pattern id="${ids.finish}" width="${int(cell)}" height="${int(cell)}" patternUnits="userSpaceOnUse" patternTransform="rotate(${num(params.angle)})">` +
        `<circle cx="${int(cell / 2)}" cy="${int(cell / 2)}" r="${num(Math.max(0.5, cell * 0.32))}" fill="#000000" opacity="0.28"/>` +
        `</pattern>`,
    );
  }
  if (kind === "duotone") {
    const sorted = [...new Set(palette.colors)].sort((a, b) => luminance(a) - luminance(b));
    const shadow = sorted[0] ?? FALLBACK_PALETTE.background;
    const highlight = sorted[sorted.length - 1] ?? FALLBACK_PALETTE.text;
    defs.push(
      `<filter id="${ids.finish}" x="0%" y="0%" width="100%" height="100%">` +
        `<feColorMatrix type="matrix" values="${duotoneMatrix(shadow, highlight, params.amount)}"/>` +
        `</filter>`,
    );
  }
  if (kind === "chroma") {
    const off = num(params.offset);
    const red = "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0";
    const green = "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0";
    const blue = "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0";
    defs.push(
      `<filter id="${ids.finish}" x="0%" y="0%" width="100%" height="100%">` +
        `<feOffset in="SourceGraphic" dx="-${off}" dy="0" result="ro"/>` +
        `<feColorMatrix in="ro" type="matrix" values="${red}" result="rc"/>` +
        `<feOffset in="SourceGraphic" dx="${off}" dy="0" result="bo"/>` +
        `<feColorMatrix in="bo" type="matrix" values="${blue}" result="bc"/>` +
        `<feColorMatrix in="SourceGraphic" type="matrix" values="${green}" result="gc"/>` +
        `<feBlend in="rc" in2="gc" mode="screen" result="rg"/>` +
        `<feBlend in="rg" in2="bc" mode="screen"/>` +
        `</filter>`,
    );
  }
  if (kind === "smear") {
    defs.push(
      `<filter id="${ids.finish}" x="-5%" y="-5%" width="110%" height="110%">` +
        `<feGaussianBlur stdDeviation="${num(params.amount)} 0"/>` +
        `</filter>`,
    );
  }
  if (kind === "glow") {
    defs.push(
      `<radialGradient id="${ids.finish}" cx="72%" cy="26%" r="58%">` +
        `<stop offset="0" stop-color="${palette.accent}" stop-opacity="${num(clampUnit(params.intensity) * 0.55)}"/>` +
        `<stop offset="0.55" stop-color="${palette.extra}" stop-opacity="${num(clampUnit(params.intensity) * 0.2)}"/>` +
        `<stop offset="1" stop-color="${palette.accent}" stop-opacity="0"/>` +
        `</radialGradient>`,
    );
  }
  return defs;
}

function finishOverlay(kind, ids, params, width, height) {
  if (GRADED_KINDS.has(kind) || kind === "shadow") return [];
  const opacity = kind === "grain" ? ` opacity="${num(params.amount)}"` : "";
  return [
    `<rect width="${int(width)}" height="${int(height)}" fill="url(#${ids.finish})"${opacity} data-part="finish" data-finish="${kind}"/>`,
  ];
}

function transitionGlyph(type, accent, ink) {
  const stroke = `fill="none" stroke="${ink}" stroke-width="2"`;
  switch (type) {
    case "none":
      return `<path d="M8 14 H52" fill="none" stroke="${ink}" stroke-width="3"/>`;
    case "cut":
      return (
        `<rect x="4" y="4" width="24" height="20" fill="${accent}"/>` +
        `<rect x="32" y="4" width="24" height="20" ${stroke}/>`
      );
    case "fade": {
      let rects = "";
      for (let i = 0; i < 5; i += 1) {
        rects += `<rect x="${4 + i * 11}" y="6" width="11" height="16" fill="${accent}" opacity="${num((i + 1) / 6)}"/>`;
      }
      return rects;
    }
    case "blur":
      return (
        `<rect x="6" y="5" width="18" height="18" fill="${accent}"/>` +
        `<rect x="21" y="5" width="18" height="18" fill="${accent}" opacity="0.45"/>` +
        `<rect x="36" y="5" width="18" height="18" fill="${accent}" opacity="0.18"/>`
      );
    case "slide":
      return (
        `<rect x="4" y="6" width="24" height="16" fill="${accent}"/>` +
        `<path d="M32 14 h12 m-5 -5 l5 5 l-5 5" fill="none" stroke="${ink}" stroke-width="2.5"/>` +
        `<rect x="44" y="6" width="12" height="16" ${stroke}/>`
      );
    case "push":
      return (
        `<rect x="4" y="4" width="26" height="20" fill="${accent}"/>` +
        `<path d="M34 14 h8 m-4 -4 l4 4 l-4 4" fill="none" stroke="${ink}" stroke-width="2.5"/>` +
        `<rect x="44" y="4" width="12" height="20" fill="${ink}" opacity="0.85"/>`
      );
    case "wipe":
      return (
        `<rect x="4" y="4" width="52" height="20" ${stroke}/>` +
        `<path d="M4 4 H36 L4 24 Z" fill="${accent}"/>`
      );
    case "zoom":
      return (
        `<rect x="4" y="4" width="52" height="20" ${stroke}/>` +
        `<rect x="18" y="8" width="24" height="12" ${stroke}/>` +
        `<rect x="27" y="11" width="6" height="6" fill="${accent}"/>`
      );
    case "iris":
      return (
        `<circle cx="30" cy="14" r="12" ${stroke}/>` +
        `<polygon points="30,6 37,10 37,18 30,22 23,18 23,10" fill="${accent}"/>`
      );
    case "paper-reveal":
      return (
        `<rect x="4" y="4" width="52" height="20" ${stroke}/>` +
        `<path d="M4 4 H28 l-3 4 l3 4 l-3 4 l3 4 l-3 4 H4 Z" fill="${accent}"/>`
      );
    case "draw-reveal":
      return (
        `<path d="M6 22 C16 6 30 26 54 8" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>` +
        `<circle cx="54" cy="8" r="3" fill="${ink}"/>`
      );
    case "shape-reveal":
      return (
        `<rect x="4" y="6" width="18" height="16" ${stroke}/>` +
        `<path d="M26 14 h8 m-3 -3 l3 3 l-3 3" fill="none" stroke="${ink}" stroke-width="2"/>` +
        `<circle cx="46" cy="14" r="9" fill="${accent}"/>`
      );
    default:
      return `<rect x="4" y="4" width="24" height="20" fill="${accent}"/><rect x="32" y="4" width="24" height="20" ${stroke}/>`;
  }
}

/**
 * Render a deterministic SVG style frame for a recipe.
 * @param {object} recipe a comfyrizz.recipe/v1 document (tolerated loosely)
 * @param {{width?: number, height?: number, text?: string, seed?: number}} [options]
 * @returns {string} a self-contained SVG document
 */
export function styleFrame(recipe = {}, options = {}) {
  const rec = recipe && typeof recipe === "object" && !Array.isArray(recipe) ? recipe : {};
  const width = dim(options.width, 320);
  const height = dim(options.height, 180);

  const palette = readPalette(rec.palette);
  const fontDisplay = fontFamilyOf(rec.fonts?.display);
  const fontText = fontFamilyOf(rec.fonts?.text);

  const rawPattern = rec.background?.pattern;
  const pattern = BACKGROUND_PATTERNS.includes(rawPattern) ? rawPattern : BACKGROUND_PATTERNS[0];

  const finish = firstFinish(rec.finish);
  const kind = finishKindOf(finish.id);
  const params = resolveFinishParams(kind, finish.params);

  const transition = primaryTransition(rec.transitions);
  const energy = typeof rec.taxonomy?.energy === "string" ? rec.taxonomy.energy : "medium";
  const personality = typeof rec.easing?.personality === "string" ? rec.easing.personality : "editorial";

  const idSeed = typeof rec.id === "string" ? rec.id : "look";
  const extraSeed = Number.isFinite(Number(options.seed)) ? Math.abs(Math.round(Number(options.seed))) : 0;
  const grainSeed = (hashSeed(`${idSeed}:${extraSeed}`) % 10000);

  const slug =
    idSeed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `f${grainSeed}`;

  const ids = {
    slug,
    bgGradient: `bg-gradient--${slug}`,
    bgGrid: `bg-grid--${slug}`,
    bgDots: `bg-dots--${slug}`,
    bgGrain: `bg-grain--${slug}`,
    bgMeshA: `bg-mesh-a--${slug}`,
    bgMeshB: `bg-mesh-b--${slug}`,
    bgMeshC: `bg-mesh-c--${slug}`,
    finish: `finish-${kind}--${slug}`,
  };

  const margin = Math.max(8, Math.round(Math.min(width, height) / 16));
  const labelSize = Math.max(7, Math.round(height * 0.055));
  const metaSize = Math.max(6, Math.round(height * 0.045));
  const swatchSize = Math.max(8, Math.round(height * 0.09));
  const swatchGap = Math.max(2, Math.round(swatchSize * 0.25));
  const glyphW = Math.max(28, Math.round(width * 0.2));
  const glyphH = Math.max(14, Math.round(height * 0.17));
  const glyphX = width - margin - glyphW;
  const glyphY = height - margin - metaSize - 4 - glyphH;
  const swatchY = height - margin - swatchSize;
  const captionY = swatchY + Math.round(swatchSize * 0.72);
  const ruleW = Math.max(18, Math.round(width * 0.08));
  const labelY = margin + 8 + Math.round(labelSize * 0.85);

  const label = String(rec.label ?? rec.id ?? "Look");
  const headlineRaw = String(options.text ?? label);
  const headlinePoints = Math.max(1, [...headlineRaw].length);
  const minHeadline = Math.max(10, Math.round(height * 0.07));
  const maxHeadline = Math.max(minHeadline, Math.round(height * 0.3));
  const avail = Math.max(40, width - margin * 2 - 8);
  const headlineSize = Math.min(maxHeadline, Math.max(minHeadline, Math.floor(avail / (0.55 * headlinePoints))));
  const headlineY = Math.min(Math.round(height * 0.6), glyphY - 6);
  const metaY = Math.min(swatchY - 4, headlineY + Math.round(headlineSize * 0.3) + metaSize + 2);
  const headlineX = margin;

  const meta = [energy, personality, pattern, finish.id || "no-finish"].filter(Boolean).join(" · ");

  const glyphScale = Math.max(0.4, Math.min(glyphW / GLYPH_BOX.w, glyphH / GLYPH_BOX.h));

  const defs = [];
  defs.push(...backgroundDefs(pattern, palette, ids, { cell: Math.max(8, Math.round(Math.min(width, height) / 9)), grain: grainSeed }));
  defs.push(...finishDefs(kind, params, ids, { grain: grainSeed }, width, height, palette));

  const backgroundParts = [
    `<rect width="${int(width)}" height="${int(height)}" fill="${palette.background}" data-part="background"/>`,
    `<g data-part="background-pattern" data-pattern="${escapeXml(pattern)}">`,
    ...backgroundPatternMarkup(pattern, palette, ids, grainSeed, width, height),
    `</g>`,
  ];

  const scene = [];
  scene.push(`<rect x="${int(margin)}" y="${int(margin)}" width="${int(ruleW)}" height="3" fill="${palette.accent}" data-part="accent-rule"/>`);
  scene.push(
    `<text x="${int(margin)}" y="${int(labelY)}" font-family="${escapeXml(fontText)}" font-size="${int(labelSize)}" fill="${palette.text}" opacity="0.9" data-part="label">${escapeXml(label)}</text>`,
  );

  const shadow = kind === "shadow" ? params : null;
  const headlineAttrs = `x="${int(headlineX)}" y="${int(headlineY)}" font-family="${escapeXml(fontDisplay)}" font-size="${int(headlineSize)}" fill="${palette.text}" data-part="headline"`;
  if (shadow) {
    scene.push(
      `<text x="${int(headlineX + shadow.offset)}" y="${int(headlineY + shadow.offset)}" font-family="${escapeXml(fontDisplay)}" font-size="${int(headlineSize)}" fill="#000000" opacity="${num(shadow.opacity)}">${escapeXml(headlineRaw)}</text>`,
    );
  }
  scene.push(`<text ${headlineAttrs}>${escapeXml(headlineRaw)}</text>`);

  scene.push(
    `<text x="${int(margin)}" y="${int(metaY)}" font-family="${escapeXml(fontText)}" font-size="${int(metaSize)}" fill="${palette.muted}" data-part="meta">${escapeXml(meta)}</text>`,
  );

  const swatches = palette.colors.slice(0, 6);
  swatches.forEach((hex, index) => {
    const x = margin + index * (swatchSize + swatchGap);
    if (shadow) {
      scene.push(
        `<rect x="${int(x + shadow.offset)}" y="${int(swatchY + shadow.offset)}" width="${int(swatchSize)}" height="${int(swatchSize)}" fill="#000000" opacity="${num(shadow.opacity)}"/>`,
      );
    }
    const role = Array.isArray(rec.palette) && rec.palette[index] && typeof rec.palette[index].role === "string" ? rec.palette[index].role : `c${index}`;
    scene.push(
      `<rect x="${int(x)}" y="${int(swatchY)}" width="${int(swatchSize)}" height="${int(swatchSize)}" fill="${hex}" stroke="${palette.text}" stroke-opacity="0.25" data-part="swatch" data-role="${escapeXml(role)}"/>`,
    );
  });

  scene.push(
    `<g transform="translate(${int(glyphX)} ${int(glyphY)}) scale(${num(glyphScale)})" data-part="transition-glyph" data-glyph="${escapeXml(transition)}">` +
      transitionGlyph(transition, palette.accent, palette.text) +
      `</g>`,
  );
  scene.push(
    `<text x="${int(width - margin)}" y="${int(captionY)}" text-anchor="end" font-family="${escapeXml(fontText)}" font-size="${int(metaSize)}" fill="${palette.muted}" data-part="transition-label">${escapeXml(transition)}</text>`,
  );

  const graded = GRADED_KINDS.has(kind);
  const frameAttrs = [];
  if (graded) frameAttrs.push(` filter="url(#${ids.finish})"`);
  if (graded || kind === "shadow") frameAttrs.push(` data-finish="${kind}"`);
  const parts = [];
  parts.push(
    `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 ${int(width)} ${int(height)}" width="${int(width)}" height="${int(height)}" role="img" data-recipe="${escapeXml(idSeed)}" aria-label="Style frame: ${escapeXml(label)}">`,
  );
  parts.push(`<title>${escapeXml(`Style frame: ${label}`)}</title>`);
  parts.push(`<defs>${defs.join("")}</defs>`);
  parts.push(`<g data-part="frame"${frameAttrs.join("")}>`);
  parts.push(...backgroundParts);
  parts.push(...scene);
  parts.push(`</g>`);
  parts.push(...finishOverlay(kind, ids, params, width, height));
  parts.push(`</svg>`);
  return parts.join("\n");
}

export default styleFrame;
