export const LOOK_SCHEMA_ID = "comfyrizz.look/v1";

export const LOOK_FONT_FILES = Object.freeze({
  Inter: "Inter-Variable.ttf",
  "JetBrains Mono": "JetBrainsMono-Regular.ttf",
  "Space Grotesk": "SpaceGrotesk[wght].ttf",
  "Playfair Display": "PlayfairDisplay[wght].ttf",
  Fraunces: "Fraunces[wght].ttf",
  "DM Serif Display": "DMSerifDisplay[wght].ttf",
  "Archivo Black": "ArchivoBlack-Regular.ttf",
  "Bebas Neue": "BebasNeue[wght].ttf",
  "IBM Plex Mono": "IBMPlexMono[wght].ttf",
  "Instrument Serif": "InstrumentSerif[wght].ttf",
  Syne: "Syne[wght].ttf",
  "Press Start 2P": "PressStart2P-Regular.ttf",
  Caveat: "Caveat[wght].ttf",
  Orbitron: "Orbitron[wght].ttf",
  Unbounded: "Unbounded[wght].ttf",
  VT323: "VT323-Regular.ttf",
  Monoton: "Monoton-Regular.ttf",
});

export const LOOK_EFFECT_IDS = Object.freeze([
  "film-grain",
  "grain-fine",
  "paper-grain",
  "paper-texture",
  "dust-scratches",
  "halftone",
  "light-leak",
  "halation",
  "bloom",
  "glow-text",
  "chrome-sheen",
  "soft-glow",
  "vignette-soft",
  "vignette-hard",
  "chroma-shift",
  "motion-smear",
  "depth-blur",
  "scanlines",
  "scanlines-soft",
  "crt-curve",
  "vhs-tracking",
  "glitch-slice",
  "pixelate-in",
  "mono-grade",
  "sepia-grade",
  "duotone",
  "teal-orange",
  "lut",
  "riso-misregister",
  "hard-shadow",
  "drop-shadow",
  "soft-shadow",
  "boil-line",
  "push-in",
  "drift",
  "parallax-layers",
  "rack-focus",
  "gate-weave",
]);

const ALIASES = Object.freeze({
  grain: "film-grain",
  "chromatic-aberration": "chroma-shift",
  scanline: "scanlines",
  vignette: "vignette-soft",
  grade: "mono-grade",
  "colour-grade": "mono-grade",
});

const PARAM_SPECS = Object.freeze({
  "film-grain": { amount: [0, 1, 0.12], size: [0.5, 8, 2], seed: [0, 9999, 1337] },
  "grain-fine": { amount: [0, 1, 0.06], size: [0.5, 4, 1] },
  "paper-grain": { amount: [0, 1, 0.08], contrast: [0, 1, 0.5] },
  "paper-texture": { scale: [0.5, 4, 1], opacity: [0, 1, 0.35] },
  "dust-scratches": { density: [0, 1, 0.3], opacity: [0, 1, 0.5] },
  halftone: { dotSize: [0.5, 8, 2], angle: [0, 360, 45] },
  "light-leak": { intensity: [0, 1, 0.6], hue: [0, 360, 25], softness: [0, 1, 0.5] },
  halation: { threshold: [0, 1, 0.7], radius: [1, 60, 18] },
  bloom: { intensity: [0, 1, 0.5], radius: [1, 120, 24] },
  "glow-text": { intensity: [0, 1, 0.6], spread: [0, 60, 12] },
  "chrome-sheen": { angle: [0, 360, 105], sharpness: [0, 1, 0.35], width: [0, 1, 0.35] },
  "soft-glow": { intensity: [0, 1, 0.35], radius: [1, 120, 30] },
  "vignette-soft": { amount: [0, 1, 0.35], radius: [0, 1, 0.65] },
  "vignette-hard": { amount: [0, 1, 0.6], radius: [0, 1, 0.45] },
  "chroma-shift": { offset: [0, 40, 2], angle: [0, 360, 0] },
  "motion-smear": { amount: [0, 40, 6], direction: [0, 360, 0] },
  "depth-blur": { amount: [0, 40, 4], layers: [1, 8, 3] },
  scanlines: { count: [20, 900, 240], opacity: [0, 1, 0.35] },
  "scanlines-soft": { count: [20, 900, 120], opacity: [0, 1, 0.15] },
  "crt-curve": { curvature: [0, 1, 0.4], bezel: [0, 40, 6] },
  "vhs-tracking": { bandHeight: [0, 1, 0.18], intensity: [0, 1, 0.5] },
  "glitch-slice": { slices: [1, 40, 8], offset: [0, 120, 18] },
  "pixelate-in": { size: [2, 64, 12], steps: [1, 20, 6] },
  "mono-grade": { amount: [0, 1, 1], contrast: [0.5, 2, 1.05] },
  "sepia-grade": { amount: [0, 1, 0.8] },
  duotone: { amount: [0, 1, 0.9], contrast: [0.5, 2, 1] },
  "teal-orange": { amount: [0, 1, 0.85], balance: [0, 1, 0.25] },
  lut: { amount: [0, 1, 1], contrast: [0.5, 2, 1] },
  "riso-misregister": { offset: [0, 40, 3], angle: [0, 360, 8] },
  "hard-shadow": { offset: [0, 40, 8], blur: [0, 40, 0] },
  "drop-shadow": { offsetY: [0, 60, 10], blur: [0, 60, 14], opacity: [0, 1, 0.35] },
  "soft-shadow": { offsetY: [0, 60, 6], blur: [0, 80, 24], opacity: [0, 1, 0.3] },
  "boil-line": { jitter: [0, 20, 2], rate: [1, 60, 8], seed: [0, 9999, 4242] },
  "push-in": { amount: [0, 1, 0.12], duration: [0.1, 30, 4] },
  drift: { amount: [0, 60, 4], rate: [0, 10, 0.6], seed: [0, 9999, 77] },
  "parallax-layers": { depth: [0, 2, 0.6], amount: [0, 120, 24] },
  "rack-focus": { amount: [0, 40, 5], duration: [0.1, 30, 2] },
  "gate-weave": { amount: [0, 20, 2], rate: [0, 10, 0.7], seed: [0, 9999, 11] },
});

const ORDER = Object.freeze({
  halation: 10,
  bloom: 12,
  "soft-glow": 13,
  "glow-text": 14,
  "light-leak": 20,
  "chrome-sheen": 22,
  scanlines: 40,
  "scanlines-soft": 40,
  "crt-curve": 41,
  "vhs-tracking": 42,
  "glitch-slice": 43,
  "pixelate-in": 44,
  "riso-misregister": 46,
  "boil-line": 48,
  "film-grain": 60,
  "grain-fine": 61,
  "paper-grain": 62,
  "paper-texture": 63,
  "dust-scratches": 64,
  halftone: 65,
  duotone: 66,
  "vignette-soft": 80,
  "vignette-hard": 80,
});

const DEFAULT_PALETTE = Object.freeze(["#0b0b12", "#f5f0e6", "#ff8a3d", "#6b6b76"]);
const TRANSPARENT = "rgba(0,0,0,0)";

const isObj = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isStr = value => typeof value === "string" && value.length > 0;

export function hasLook(look) {
  return Boolean(
    isObj(look) &&
    look.schema === LOOK_SCHEMA_ID &&
    isStr(look.recipeId) &&
    Array.isArray(look.finish),
  );
}

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function param(effectId, params, name) {
  const spec = PARAM_SPECS[effectId] && PARAM_SPECS[effectId][name];
  const fallback = spec ? spec[2] : 0;
  const raw = isObj(params) && Number.isFinite(params[name]) ? params[name] : fallback;
  if (!spec) return raw;
  return clamp(raw, spec[0], spec[1]);
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function paletteColor(palette, index, fallback) {
  if (Array.isArray(palette) && isStr(palette[index])) return palette[index];
  return fallback;
}

function normalizeId(id) {
  return ALIASES[id] || id;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(look, frame) {
  return (Math.trunc(finite(look && look.seed, 0)) + Math.trunc(frame)) >>> 0;
}

function grainLayer(id, params, look, frame) {
  const amount = param(id, params, "amount");
  const size = id === "paper-grain" ? 1 : param(id, params, "size");
  const baseSeed = id === "paper-grain" ? 1337 : id === "grain-fine" ? 91 : 1337;
  const animatedSeed = (baseSeed + seedOf(look, Math.floor(frame / 2))) % 10000;
  const baseFrequency = id === "paper-grain" ? round(0.16 / size) : round(0.75 / size);
  return {
    kind: "grain",
    order: ORDER[id],
    opacity: round(clamp(amount, 0, 1)),
    style: {
      position: "absolute",
      inset: 0,
      opacity: round(clamp(amount, 0, 1)),
      mixBlendMode: id === "paper-grain" ? "multiply" : "overlay",
      pointerEvents: "none",
    },
    svg: {
      type: "fractalNoise",
      baseFrequency,
      numOctaves: id === "paper-grain" ? 4 : 3,
      seed: animatedSeed,
      stitchTiles: "stitch",
    },
  };
}

function paperTextureLayer(params) {
  const opacity = param("paper-texture", params, "opacity");
  const scale = param("paper-texture", params, "scale");
  return {
    kind: "grain",
    order: ORDER["paper-texture"],
    opacity: round(opacity),
    style: {
      position: "absolute",
      inset: 0,
      opacity: round(opacity),
      mixBlendMode: "multiply",
      pointerEvents: "none",
    },
    svg: {
      type: "fractalNoise",
      baseFrequency: round(0.28 / scale),
      numOctaves: 5,
      seed: 520,
      stitchTiles: "stitch",
    },
  };
}

function dustLayer(params, look, frame, width, height) {
  const density = param("dust-scratches", params, "density");
  const opacity = param("dust-scratches", params, "opacity");
  const random = mulberry32(seedOf(look, frame));
  const count = Math.round(density * 90);
  const specks = [];
  for (let index = 0; index < count; index += 1) {
    specks.push({
      x: round(random() * width, 2),
      y: round(random() * height, 2),
      r: round(0.6 + random() * 2.4, 2),
      opacity: round(0.2 + random() * 0.7, 3),
    });
  }
  const scratches = [];
  const scratchCount = Math.round(density * 7);
  for (let index = 0; index < scratchCount; index += 1) {
    scratches.push({
      x: round(random() * width, 2),
      y: round(random() * height, 2),
      length: round(height * (0.08 + random() * 0.3), 2),
      width: round(0.5 + random() * 1.2, 2),
      opacity: round(0.15 + random() * 0.4, 3),
    });
  }
  return {
    kind: "dust",
    order: ORDER["dust-scratches"],
    opacity: round(opacity),
    style: {
      position: "absolute",
      inset: 0,
      opacity: round(opacity),
      mixBlendMode: "screen",
      pointerEvents: "none",
    },
    specks,
    scratches,
  };
}

function halftoneLayer(params) {
  const dotSize = param("halftone", params, "dotSize");
  const angle = param("halftone", params, "angle");
  const radius = round(dotSize / 2, 3);
  return {
    kind: "halftone",
    order: ORDER.halftone,
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: `radial-gradient(circle at center, rgba(0,0,0,0.55) 0 ${radius}px, ${TRANSPARENT} ${radius}px)`,
      backgroundSize: `${dotSize}px ${dotSize}px`,
      backgroundPosition: "0 0",
      transform: `rotate(${angle}deg) scale(1.5)`,
      mixBlendMode: "multiply",
      opacity: 0.55,
      pointerEvents: "none",
    },
  };
}

function lightLeakLayer(params, frame, palette) {
  const intensity = param("light-leak", params, "intensity");
  const hue = param("light-leak", params, "hue");
  const softness = param("light-leak", params, "softness");
  const drift = (frame * 0.6) % 100;
  const accent = paletteColor(palette, 2, "#ff8a3d");
  return {
    kind: "light-leak",
    order: ORDER["light-leak"],
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: [
        `radial-gradient(circle at ${12 + drift * 0.08}% ${18 + drift * 0.04}%, hsla(${hue}, 100%, 68%, 0.9) 0%, ${TRANSPARENT} ${42 + softness * 30}%)`,
        `radial-gradient(circle at ${88 - drift * 0.05}% ${72 - drift * 0.03}%, hsla(${(hue + 34) % 360}, 100%, 58%, 0.7) 0%, ${TRANSPARENT} ${34 + softness * 26}%)`,
        `radial-gradient(ellipse at 50% 120%, ${accent} 0%, ${TRANSPARENT} 55%)`,
      ].join(", "),
      mixBlendMode: "screen",
      opacity: round(clamp(intensity, 0, 1)),
      filter: `blur(${round(softness * 24, 2)}px)`,
      pointerEvents: "none",
    },
  };
}

function halationLayer(params, palette) {
  const threshold = param("halation", params, "threshold");
  const radius = param("halation", params, "radius");
  const accent = paletteColor(palette, 2, "#ffb37a");
  return {
    kind: "halation",
    order: ORDER.halation,
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: `radial-gradient(circle at 50% 34%, ${accent} 0%, rgba(255,179,122,0.42) 16%, ${TRANSPARENT} ${58 + threshold * 20}%)`,
      backdropFilter: `blur(${round(radius, 2)}px) brightness(${round(1 + threshold * 0.5, 2)}) saturate(1.25)`,
      mixBlendMode: "screen",
      opacity: round(0.28 + threshold * 0.35, 3),
      pointerEvents: "none",
    },
  };
}

function vignetteLayer(id, params) {
  const amount = param(id, params, "amount");
  const radius = param(id, params, "radius");
  const inner = round(clamp(radius, 0, 1) * 100, 2);
  return {
    kind: "vignette",
    order: ORDER[id],
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: `radial-gradient(ellipse at center, ${TRANSPARENT} ${inner}%, rgba(0,0,0,${round(clamp(amount, 0, 1), 3)}) 100%)`,
      mixBlendMode: "multiply",
      pointerEvents: "none",
    },
  };
}

function scanlinesLayer(id, params, frame, height) {
  const count = param(id, params, "count");
  const opacity = param(id, params, "opacity");
  const line = round(Math.max(1.5, height / count), 2);
  const offset = round((frame % Math.max(1, line)) % Math.max(1, line), 2);
  return {
    kind: "scanlines",
    order: ORDER[id],
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: `repeating-linear-gradient(to bottom, rgba(0,0,0,${round(opacity, 3)}) 0px, rgba(0,0,0,${round(opacity, 3)}) ${round(line / 2, 2)}px, ${TRANSPARENT} ${round(line / 2, 2)}px, ${TRANSPARENT} ${line}px)`,
      backgroundPositionY: `${offset}px`,
      mixBlendMode: "multiply",
      pointerEvents: "none",
    },
  };
}

function crtLayer(params, height) {
  const curvature = param("crt-curve", params, "curvature");
  const bezel = param("crt-curve", params, "bezel");
  const line = round(Math.max(1.5, height / 260), 2);
  return {
    kind: "crt",
    order: ORDER["crt-curve"],
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: [
        `repeating-linear-gradient(to bottom, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, ${TRANSPARENT} 1px, ${TRANSPARENT} ${line}px)`,
        `radial-gradient(ellipse at center, ${TRANSPARENT} ${round(58 - curvature * 22, 2)}%, rgba(0,0,0,${round(0.18 + curvature * 0.4, 3)}) 100%)`,
      ].join(", "),
      boxShadow: `inset 0 0 ${round(bezel * 3, 2)}px rgba(0,0,0,0.55)`,
      mixBlendMode: "multiply",
      pointerEvents: "none",
    },
  };
}

function chromaFilter(params) {
  const offset = param("chroma-shift", params, "offset");
  const angle = param("chroma-shift", params, "angle");
  const radians = (angle * Math.PI) / 180;
  const dx = round(Math.cos(radians) * offset, 3) || 0;
  const dy = round(Math.sin(radians) * offset, 3) || 0;
  return {
    kind: "chroma",
    chroma: { dx, dy },
  };
}

function gradeEffects(id, params, palette) {
  if (id === "duotone") {
    const amount = param(id, params, "amount");
    const contrast = param(id, params, "contrast");
    const shadow = paletteColor(palette, 0, DEFAULT_PALETTE[0]);
    const light = paletteColor(palette, 1, DEFAULT_PALETTE[1]);
    return {
      filter: `grayscale(1) contrast(${round(contrast, 3)})`,
      layer: {
        kind: "duotone",
        order: ORDER.duotone,
        tones: [shadow, light],
        style: {
          position: "absolute",
          inset: 0,
          backgroundImage: `linear-gradient(135deg, ${shadow} 0%, ${light} 100%)`,
          mixBlendMode: "color",
          opacity: round(clamp(amount, 0, 1)),
          pointerEvents: "none",
        },
      },
    };
  }
  if (id === "sepia-grade") {
    return { filter: `sepia(${round(param(id, params, "amount"), 3)})` };
  }
  if (id === "teal-orange") {
    const amount = param(id, params, "amount");
    const balance = param(id, params, "balance");
    return {
      filter: `sepia(${round(amount * 0.38, 3)}) saturate(${round(1 + amount * 0.55, 3)}) hue-rotate(${round(-12 + balance * 20, 3)}deg) contrast(${round(1 + balance * 0.08, 3)})`,
      layer: {
        kind: "teal-orange",
        order: ORDER.duotone,
        style: {
          position: "absolute",
          inset: 0,
          backgroundImage: `linear-gradient(${round(180 + balance * 40, 2)}deg, rgba(0,120,150,${round(0.32 * amount, 3)}) 0%, ${TRANSPARENT} 48%, rgba(255,132,58,${round(0.28 * amount, 3)}) 100%)`,
          mixBlendMode: "soft-light",
          pointerEvents: "none",
        },
      },
    };
  }
  if (id === "lut") {
    const amount = param(id, params, "amount");
    const contrast = param(id, params, "contrast");
    return { filter: `contrast(${round(contrast, 3)}) saturate(${round(0.9 + amount * 0.35, 3)})` };
  }
  const amount = param("mono-grade", params, "amount");
  const contrast = param("mono-grade", params, "contrast");
  return { filter: `grayscale(${round(clamp(amount, 0, 1), 3)}) contrast(${round(contrast, 3)})` };
}

function glowLayer(id, params, palette) {
  const intensity = param(id, params, "intensity");
  const radius = id === "glow-text" ? param(id, params, "spread") : param(id, params, "radius");
  const accent = paletteColor(palette, 3, "#ffffff");
  return {
    kind: id === "glow-text" ? "glow-text" : "glow",
    order: ORDER[id] || 12,
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: `radial-gradient(ellipse at 50% 42%, ${accent} 0%, ${TRANSPARENT} ${round(34 + radius * 0.9, 2)}%)`,
      filter: `blur(${round(radius * 0.5, 2)}px)`,
      mixBlendMode: "screen",
      opacity: round(clamp(intensity, 0, 1)),
      pointerEvents: "none",
    },
  };
}

function chromeLayer(params, frame) {
  const angle = param("chrome-sheen", params, "angle");
  const sharpness = param("chrome-sheen", params, "sharpness");
  const width = param("chrome-sheen", params, "width");
  const position = round(((frame * 1.5) % 220) - 60, 2);
  const hard = round(18 - sharpness * 14, 2);
  return {
    kind: "sheen",
    order: ORDER["chrome-sheen"],
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: `linear-gradient(${angle}deg, ${TRANSPARENT} ${position}%, rgba(255,255,255,${round(0.18 + width * 0.25, 3)}) ${round(position + hard, 2)}%, rgba(180,240,255,0.32) ${round(position + hard * 1.5, 2)}%, ${TRANSPARENT} ${round(position + hard * 3, 2)}%)`,
      mixBlendMode: "screen",
      pointerEvents: "none",
    },
  };
}

function vhsLayer(params, frame) {
  const bandHeight = param("vhs-tracking", params, "bandHeight");
  const intensity = param("vhs-tracking", params, "intensity");
  const band = round(20 + bandHeight * 160, 2);
  return {
    kind: "vhs",
    order: ORDER["vhs-tracking"],
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: `repeating-linear-gradient(to bottom, rgba(255,255,255,0.16) 0px, rgba(255,255,255,0.16) 2px, rgba(0,0,0,0.22) 2px, rgba(0,0,0,0.22) 4px, ${TRANSPARENT} 4px, ${TRANSPARENT} ${band}px)`,
      backgroundPositionY: `${round((frame * 7) % Math.max(1, band), 2)}px`,
      mixBlendMode: "overlay",
      opacity: round(clamp(intensity, 0, 1)),
      pointerEvents: "none",
    },
  };
}

function glitchLayer(params, look, frame, width) {
  const slices = Math.round(param("glitch-slice", params, "slices"));
  const offset = param("glitch-slice", params, "offset");
  const random = mulberry32(seedOf(look, frame));
  const stops = [];
  for (let index = 0; index < slices; index += 1) {
    const start = round((index / slices) * 100, 3);
    const end = round(((index + 0.55) / slices) * 100, 3);
    const alpha = round(0.06 + random() * 0.22, 3);
    const color = random() > 0.5 ? `rgba(255,0,90,${alpha})` : `rgba(0,229,255,${alpha})`;
    stops.push(`${color} ${start}%`, `transparent ${end}%`);
  }
  return {
    kind: "glitch",
    order: ORDER["glitch-slice"],
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: `repeating-linear-gradient(180deg, ${stops.join(", ")})`,
      transform: `translateX(${round(Math.sin(frame * 0.9) * offset * 0.35, 2)}px)`,
      mixBlendMode: "screen",
      opacity: round(clamp(0.45 + offset / Math.max(1, width), 0, 1), 3),
      pointerEvents: "none",
    },
  };
}

function pixelateLayer(params) {
  const size = param("pixelate-in", params, "size");
  const steps = param("pixelate-in", params, "steps");
  return {
    kind: "pixelate",
    order: ORDER["pixelate-in"],
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: [
        `repeating-linear-gradient(90deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, ${TRANSPARENT} 1px, ${TRANSPARENT} ${size}px)`,
        `repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, ${TRANSPARENT} 1px, ${TRANSPARENT} ${size}px)`,
      ].join(", "),
      backgroundSize: `${size}px ${size}px, ${size}px ${size}px`,
      mixBlendMode: "overlay",
      opacity: round(clamp(steps / 20, 0, 1), 3),
      pointerEvents: "none",
    },
  };
}

function risoLayer(params, palette) {
  const offset = param("riso-misregister", params, "offset");
  const angle = param("riso-misregister", params, "angle");
  const accent = paletteColor(palette, 2, "#ff4f7b");
  return {
    kind: "riso",
    order: ORDER["riso-misregister"],
    style: {
      position: "absolute",
      inset: -offset,
      backgroundImage: `linear-gradient(${angle}deg, ${accent} 0%, ${TRANSPARENT} 62%)`,
      mixBlendMode: "multiply",
      opacity: 0.35,
      transform: `translate(${round(offset, 2)}px, ${round(-offset * 0.5, 2)}px)`,
      pointerEvents: "none",
    },
  };
}

function shadowFilter(id, params) {
  const offsetY = id === "hard-shadow" ? param(id, params, "offset") : param(id, params, "offsetY");
  const blur = param(id, params, "blur");
  const opacity = id === "hard-shadow" ? 1 : param(id, params, "opacity");
  return {
    kind: "shadow",
    filter: `drop-shadow(0 ${round(offsetY, 2)}px ${round(blur, 2)}px rgba(0,0,0,${round(clamp(opacity, 0, 1), 3)}))`,
  };
}

function motionBlurFilter(params) {
  const amount = param("motion-smear", params, "amount");
  return { kind: "blur", filter: `blur(${round(amount, 2)}px)` };
}

function depthBlurFilter(params) {
  const amount = param("depth-blur", params, "amount");
  return { kind: "blur", filter: `blur(${round(amount, 2)}px)` };
}

function boilLayer(params, look, frame) {
  const jitter = param("boil-line", params, "jitter");
  const rate = param("boil-line", params, "rate");
  const base = param("boil-line", params, "seed");
  const seed = (Math.trunc(base) + seedOf(look, Math.floor((frame * rate) / 30))) % 10000;
  return {
    kind: "boil",
    order: ORDER["boil-line"],
    opacity: round(clamp(jitter / 20, 0.02, 0.18), 3),
    style: {
      position: "absolute",
      inset: 0,
      opacity: round(clamp(jitter / 20, 0.02, 0.18), 3),
      mixBlendMode: "overlay",
      pointerEvents: "none",
    },
    svg: {
      type: "turbulence",
      baseFrequency: 0.012,
      numOctaves: 2,
      seed,
      stitchTiles: "stitch",
    },
  };
}

function cameraTransform(id, params, look, frame, durationInFrames) {
  const progress = durationInFrames > 0 ? clamp(frame / durationInFrames, 0, 1) : 0;
  if (id === "push-in") {
    const amount = param(id, params, "amount");
    return { kind: "camera", transform: `scale(${round(1 + amount * progress, 4)})` };
  }
  if (id === "drift") {
    const amount = param(id, params, "amount");
    const rate = param(id, params, "rate");
    const x = round(Math.sin(seedOf(look, 0) * 0.01 + frame * rate * 0.02) * amount, 2);
    const y = round(Math.cos(seedOf(look, 0) * 0.013 + frame * rate * 0.017) * amount * 0.6, 2);
    return { kind: "camera", transform: `translate(${x}px, ${y}px)` };
  }
  if (id === "parallax-layers") {
    const amount = param(id, params, "amount");
    const depth = param(id, params, "depth");
    const x = round(Math.sin(frame * 0.012) * amount * depth, 2);
    return { kind: "camera", transform: `translateX(${x}px) scale(${round(1 + depth * 0.03, 4)})` };
  }
  if (id === "gate-weave") {
    const amount = param(id, params, "amount");
    const rate = param(id, params, "rate");
    const base = param(id, params, "seed");
    const phase = seedOf(look, 0) * 0.011 + frame * rate * 0.05 + base * 0.001;
    const x = round(Math.sin(phase) * amount, 2);
    const y = round(Math.cos(phase * 1.7) * amount * 0.6, 2);
    return { kind: "camera", transform: `translate(${x}px, ${y}px) scale(1.002)` };
  }
  const amount = param(id, params, "amount");
  const duration = param(id, params, "duration");
  const focus = duration > 0 ? Math.abs(Math.sin((frame / duration / 30) * Math.PI)) : 1;
  return { kind: "focus", filter: `blur(${round(amount * (1 - focus), 2)}px)` };
}

function buildEffect(id, params, context) {
  switch (id) {
    case "film-grain":
    case "grain-fine":
    case "paper-grain":
      return grainLayer(id, params, context.look, context.frame);
    case "paper-texture":
      return paperTextureLayer(params);
    case "dust-scratches":
      return dustLayer(params, context.look, context.frame, context.width, context.height);
    case "halftone":
      return halftoneLayer(params);
    case "light-leak":
      return lightLeakLayer(params, context.frame, context.palette);
    case "halation":
      return halationLayer(params, context.palette);
    case "bloom":
    case "soft-glow":
    case "glow-text":
      return glowLayer(id, params, context.palette);
    case "chrome-sheen":
      return chromeLayer(params, context.frame);
    case "vignette-soft":
    case "vignette-hard":
      return vignetteLayer(id, params, context.height);
    case "scanlines":
    case "scanlines-soft":
      return scanlinesLayer(id, params, context.frame, context.height);
    case "crt-curve":
      return crtLayer(params, context.height);
    case "vhs-tracking":
      return vhsLayer(params, context.frame);
    case "glitch-slice":
      return glitchLayer(params, context.look, context.frame, context.width);
    case "pixelate-in":
      return pixelateLayer(params);
    case "chroma-shift":
      return chromaFilter(params);
    case "motion-smear":
      return motionBlurFilter(params);
    case "depth-blur":
      return depthBlurFilter(params);
    case "mono-grade":
    case "sepia-grade":
    case "duotone":
    case "teal-orange":
    case "lut":
      return gradeEffects(id, params, context.palette);
    case "riso-misregister":
      return risoLayer(params, context.palette);
    case "hard-shadow":
    case "drop-shadow":
    case "soft-shadow":
      return shadowFilter(id, params);
    case "boil-line":
      return boilLayer(params, context.look, context.frame);
    case "push-in":
    case "drift":
    case "parallax-layers":
    case "rack-focus":
    case "gate-weave":
      return cameraTransform(id, params, context.look, context.frame, context.durationInFrames);
    default:
      return null;
  }
}

export function normalizeFinish(look) {
  if (!isObj(look) || !Array.isArray(look.finish)) return [];
  const out = [];
  for (const entry of look.finish) {
    const id = isStr(entry) ? entry : isObj(entry) ? entry.id : null;
    if (!isStr(id)) continue;
    const params = isObj(entry) && isObj(entry.params) ? entry.params : {};
    out.push({ id: normalizeId(id), params });
  }
  return out;
}

export function lookFontEntries(look) {
  if (!isObj(look) || !Array.isArray(look.fonts)) return [];
  const seen = new Set();
  const out = [];
  for (const font of look.fonts) {
    if (!isObj(font) || !isStr(font.family)) continue;
    const file = LOOK_FONT_FILES[font.family];
    if (!file || seen.has(font.family)) continue;
    seen.add(font.family);
    out.push({ family: font.family, file, path: `fonts/${file}` });
  }
  return out;
}

export function buildLookRender(look, options = {}) {
  if (!hasLook(look)) return null;
  const settings = isObj(options) ? options : {};
  const frame = Math.max(0, Math.trunc(finite(settings.frame, 0)));
  const width = Math.max(1, finite(settings.width, 1920));
  const height = Math.max(1, finite(settings.height, 1080));
  const durationInFrames = Math.max(0, finite(settings.durationInFrames, 0));
  const palette = Array.isArray(settings.palette) ? settings.palette.filter(isStr) : [];
  const context = { look, frame, width, height, durationInFrames, palette };

  const layers = [];
  const filters = [];
  const transforms = [];
  let chroma = null;
  for (const entry of normalizeFinish(look)) {
    const built = buildEffect(entry.id, entry.params, context);
    if (!built) continue;
    if (built.chroma) chroma = built.chroma;
    if (built.filter) filters.push(built.filter);
    if (built.transform) transforms.push(built.transform);
    const layer = built.layer || (built.style ? built : null);
    if (layer && layer.style && layer.kind && layer.kind !== "chroma" && layer.kind !== "shadow" && layer.kind !== "blur" && layer.kind !== "camera" && layer.kind !== "focus") {
      layers.push({
        kind: layer.kind,
        effectId: entry.id,
        order: layer.order ?? 50,
        opacity: layer.opacity,
        style: layer.style,
        ...(layer.svg ? { svg: layer.svg } : {}),
        ...(layer.specks ? { specks: layer.specks } : {}),
        ...(layer.scratches ? { scratches: layer.scratches } : {}),
        ...(layer.tones ? { tones: layer.tones } : {}),
      });
    }
  }

  layers.sort((a, b) => (a.order === b.order ? a.effectId.localeCompare(b.effectId) : a.order - b.order));

  return {
    schema: LOOK_SCHEMA_ID,
    recipeId: look.recipeId,
    seed: Math.trunc(finite(look.seed, 0)),
    frame,
    width,
    height,
    palette,
    fonts: lookFontEntries(look),
    sceneFilter: filters.length > 0 ? filters.join(" ") : null,
    sceneTransform: transforms.length > 0 ? transforms.join(" ") : null,
    chroma,
    layers,
  };
}

export default buildLookRender;
