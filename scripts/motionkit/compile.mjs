import { readFileSync } from "node:fs";

import {
  ANIMATION_RECIPES,
  MOTION_VOCABULARY,
  autofixMotion,
  validatePackage,
} from "../../packages/schema/src/index.mjs";
import {
  LOOK_SCHEMA_ID,
  validateLook,
  validateRecipe,
} from "./recipe-schema.mjs";
import { getTransition, resolveTransition } from "./transitions.mjs";
import { loadEffects } from "./effects.mjs";

const DEFAULT_FS = { readFileSync };

const CATALOG_BY_NATIVE = Object.freeze({
  cut: "hard-cut",
  fade: "luma-fade",
  blur: "blur-dissolve",
  slide: "slide-over",
  push: "push",
  wipe: "linear-wipe",
  zoom: "zoom-through",
  iris: "iris-open",
  "paper-reveal": "paper-tear",
  "draw-reveal": "line-draw",
  "shape-reveal": "shape-mask",
  none: "hard-cut",
});

const COPY_FIELDS = Object.freeze([
  "headline",
  "kicker",
  "sub",
  "body",
  "quote",
  "attribution",
  "footnote",
  "cta",
]);

const FONT_NAMES = Object.freeze({
  inter: "Inter",
  "jetbrains-mono": "JetBrains Mono",
  "space-grotesk": "Space Grotesk",
  "playfair-display": "Playfair Display",
  fraunces: "Fraunces",
  "dm-serif-display": "DM Serif Display",
  "archivo-black": "Archivo Black",
  "bebas-neue": "Bebas Neue",
  "ibm-plex-mono": "IBM Plex Mono",
  "instrument-serif": "Instrument Serif",
  syne: "Syne",
  "press-start-2p": "Press Start 2P",
  caveat: "Caveat",
  orbitron: "Orbitron",
  unbounded: "Unbounded",
  vt323: "VT323",
  monoton: "Monoton",
});

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStr = (value) => typeof value === "string" && value.length > 0;

function clone(value) {
  return structuredClone(value);
}

function assertSeed(seed) {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new TypeError("seed must be a non-negative integer");
  }
  return seed;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function variationKey(variation) {
  if (variation === undefined || variation === null || variation === false) return 0;
  if (variation === true) return 1;
  if (typeof variation === "number" && Number.isFinite(variation)) return Math.trunc(variation) >>> 0;
  if (typeof variation === "string") return hashString(variation);
  try {
    return hashString(JSON.stringify(variation));
  } catch {
    return 0;
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function nextInt(random, size) {
  if (size <= 0) return 0;
  return Math.min(size - 1, Math.floor(random() * size));
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!isStr(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function fontFamily(id) {
  return FONT_NAMES[id] || id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function fontAssetId(id) {
  return `a${id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}`;
}

function paletteHex(recipe, role) {
  const entry = recipe.palette.find((item) => item.role === role);
  return entry ? entry.hex : null;
}

function parseHex(value) {
  if (!isStr(value) || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  const int = Number.parseInt(value.slice(1), 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function textOn(hex) {
  const l = luminance(hex);
  if (l === null) return "#0d0f14";
  return l > 0.5 ? "#0d0f14" : "#f7f9fc";
}

function readableTexts(scene) {
  const out = [];
  const copy = isObj(scene.copy) ? scene.copy : {};
  for (const field of COPY_FIELDS) {
    if (isStr(copy[field])) out.push(copy[field]);
  }
  if (Array.isArray(copy.items)) {
    for (const item of copy.items) if (isStr(item)) out.push(item);
  }
  if (isObj(scene.lower_third)) {
    if (isStr(scene.lower_third.kicker)) out.push(scene.lower_third.kicker);
    if (isStr(scene.lower_third.text)) out.push(scene.lower_third.text);
  }
  return out;
}

function pickHighlight(scene) {
  for (const text of readableTexts(scene)) {
    const words = text.match(/[A-Za-z0-9][A-Za-z0-9'_-]*/g) || [];
    const candidates = words.filter((word) => word.length >= 3 && word.length <= 60);
    if (candidates.length > 0) {
      return candidates.reduce((best, word) => (word.length > best.length ? word : best), candidates[0]);
    }
  }
  return null;
}

function sceneHasVectorArt(scene, pkg) {
  const assets = isObj(pkg.assets) ? pkg.assets : {};
  const ids = [];
  if (isObj(scene.background) && isStr(scene.background.asset)) ids.push(scene.background.asset);
  if (Array.isArray(scene.foreground)) {
    for (const item of scene.foreground) if (isObj(item) && isStr(item.asset)) ids.push(item.asset);
  }
  return ids.some((id) => isObj(assets[id]) && (assets[id].kind === "svg" || assets[id].kind === "vector-anim"));
}

function entryAllowed(entry, scene, pkg) {
  if (!MOTION_VOCABULARY.entries.includes(entry)) return false;
  if (entry === "countUp") return isObj(scene.data) && isStr(scene.data.dataset);
  if (entry === "drawOn") return sceneHasVectorArt(scene, pkg);
  return true;
}

function storyLayoutSupports(storyRecipe, layout) {
  const story = ANIMATION_RECIPES.find((item) => item.id === storyRecipe);
  return Boolean(story && isStr(layout) && story.layouts.includes(layout));
}

function applyTheme(pkg, recipe) {
  const theme = isObj(pkg.theme) ? pkg.theme : {};
  theme.palette = recipe.palette.map((entry) => entry.hex);
  const text = paletteHex(recipe, "text");
  const muted = paletteHex(recipe, "muted");
  const background = paletteHex(recipe, "background");
  const accent = paletteHex(recipe, "accent");
  if (text) theme.text = text;
  if (muted) theme.text_muted = muted;
  if (accent) theme.text_on_accent = textOn(accent);
  else if (background) theme.text_on_accent = textOn(background);

  const ids = unique([recipe.fonts.display, recipe.fonts.text, recipe.fonts.mono]);
  theme.font = fontFamily(recipe.fonts.display);
  if (Array.isArray(theme.fonts)) {
    theme.fonts = theme.fonts.map((font, index) => ({
      ...font,
      family: fontFamily(ids[index % ids.length]),
    }));
  }
  pkg.theme = theme;
}

function effectCatalogue(fs) {
  try {
    return loadEffects({ fs }).effects;
  } catch {
    return [];
  }
}

function buildFinish(recipe, effects) {
  const byId = new Map(effects.map((effect) => [effect.id, effect]));
  const finish = [];
  for (const item of recipe.finish) {
    const id = isStr(item) ? item : item.id;
    const supplied = isObj(item) && isObj(item.params) ? item.params : {};
    const effect = byId.get(id) || null;
    const defaults = effect && isObj(effect.params)
      ? Object.fromEntries(Object.entries(effect.params).map(([name, spec]) => [name, spec.default]))
      : {};
    const params = isObj(item) && isObj(item.params) ? { ...supplied } : { ...defaults };
    const cpuFallback = effect
      ? effect.cost === "css" || effect.cost === "svg" || Boolean(effect.cpuFallback)
      : true;
    finish.push({ id, params, cpuFallback });
  }
  return finish;
}

function transitionType(recipe, index, primary, accents, accentOffset) {
  if (accents.length > 0 && (index + accentOffset) % 3 === 2) {
    return accents[(index + accentOffset) % accents.length];
  }
  return primary;
}

function catalogIdFor(type) {
  return CATALOG_BY_NATIVE[type] || CATALOG_BY_NATIVE[type === "none" ? "none" : "cut"];
}

function transitionPlan(recipe, sceneCount, random) {
  const primary = recipe.transitions.primary;
  const accents = recipe.transitions.accent.filter((value) => value !== primary);
  const accentOffset = nextInt(random, Math.max(1, accents.length + 2));
  const plan = [];
  for (let index = 0; index < sceneCount; index += 1) {
    const type = transitionType(recipe, index, primary, accents, accentOffset);
    plan.push({ type, catalogId: catalogIdFor(type) });
  }
  return plan;
}

function applySceneMotion(pkg, recipe, variationSeed) {
  const scenes = pkg.scenes;
  const seed = hashString(`${recipe.id}:scene-order:${variationSeed}`);
  const random = seededRandom(seed);
  const entries = unique(recipe.entries.filter((entry) => MOTION_VOCABULARY.entries.includes(entry)));
  const emphasis = unique(recipe.emphasis.filter((item) => MOTION_VOCABULARY.emphasis.includes(item)));
  const nonHero = emphasis.filter((item) => item !== "hero");
  const hasHero = emphasis.includes("hero");
  const heroIndex = hasHero && scenes.length > 0
    ? (scenes.length >= 3 ? 1 + nextInt(random, scenes.length - 1) : nextInt(random, scenes.length))
    : -1;
  const entryOffset = nextInt(random, Math.max(1, entries.length));
  const emphasisOffset = nextInt(random, Math.max(1, nonHero.length));
  const elasticIndex = recipe.easing.spring === "elastic"
    ? (heroIndex >= 0 ? heroIndex : Math.max(0, scenes.length - 1))
    : -1;
  const ease = recipe.easing.entry === "linear" ? "enter" : recipe.easing.entry;

  scenes.forEach((scene, index) => {
    const motion = isObj(scene.motion) ? scene.motion : {};
    const usableEntries = entries.filter((entry) => entryAllowed(entry, scene, pkg));
    const fallbackEntries = ["fadeUp", "maskRise", "pop"].filter((entry) => entryAllowed(entry, scene, pkg));
    const pool = usableEntries.length > 0 ? usableEntries : fallbackEntries;
    if (pool.length > 0) motion.entry = pool[(entryOffset + index) % pool.length];
    if (motion.entry === "none") motion.ease = "linear";
    else motion.ease = MOTION_VOCABULARY.easing.includes(ease) ? ease : "enter";

    const spring = recipe.easing.spring;
    if (MOTION_VOCABULARY.springs.includes(spring)) {
      motion.spring = spring === "elastic" ? (index === elasticIndex ? "elastic" : "pop") : spring;
    }

    let selected = "none";
    if (index === heroIndex) {
      selected = "hero";
    } else if (nonHero.length > 0) {
      selected = nonHero[(emphasisOffset + index) % nonHero.length];
    }
    if (selected === "keyword") {
      const highlight = pickHighlight(scene);
      if (highlight) motion.highlight = highlight;
      else selected = "none";
    }
    if (selected !== "keyword") delete motion.highlight;
    motion.emphasis = selected;
    motion.energy = recipe.taxonomy.energy;

    const storyRecipe = recipe.storyRecipe;
    if (isStr(storyRecipe) && storyLayoutSupports(storyRecipe, scene.layout)) {
      motion.recipe = storyRecipe;
    }

    scene.motion = motion;
  });
}

function applySceneTransitions(pkg, recipe, fps, fs, variationSeed) {
  const plan = transitionPlan(recipe, pkg.scenes.length, seededRandom(hashString(`${recipe.id}:transitions:${variationSeed}`)));
  pkg.scenes.forEach((scene, index) => {
    const chosen = plan[index];
    const resolved = resolveTransition(chosen.catalogId, { fs, fps });
    const transitionOut = { type: resolved.type, frames: resolved.frames };
    if (resolved.direction !== undefined) transitionOut.direction = resolved.direction;
    scene.transitionOut = transitionOut;
  });
  return plan;
}

function applyBackgrounds(pkg, recipe) {
  const pattern = recipe.background.pattern;
  for (const scene of pkg.scenes) {
    if (!isObj(scene.background)) {
      scene.background = { procedural: { pattern } };
      continue;
    }
    if (scene.background.asset !== undefined) continue;
    if (!isObj(scene.background.procedural)) scene.background.procedural = { pattern };
    else scene.background.procedural.pattern = pattern;
  }
}

function buildLook(pkg, recipe, seed, plan, effects, fs) {
  const fontIds = unique([recipe.fonts.display, recipe.fonts.text, recipe.fonts.mono]);
  const transitions = [];
  pkg.scenes.forEach((scene, index) => {
    const transitionOut = scene.transitionOut;
    if (!isObj(transitionOut) || !isStr(transitionOut.type)) return;
    const selected = plan[index];
    const catalogId = selected && selected.type === transitionOut.type
      ? selected.catalogId
      : catalogIdFor(transitionOut.type);
    const entry = getTransition(fs, catalogId);
    const item = {
      scene: scene.id,
      id: catalogId,
      native: transitionOut.type,
    };
    if (entry.glsl) item.glsl = { name: entry.glsl.name, license: entry.glsl.license };
    const overlay = entry.overlayEffect || entry.sfx;
    if (overlay) item.overlay = overlay;
    transitions.push(item);
  });

  return {
    schema: LOOK_SCHEMA_ID,
    recipeId: recipe.id,
    seed,
    fonts: fontIds.map((id) => ({ family: fontFamily(id), assetId: fontAssetId(id) })),
    finish: buildFinish(recipe, effects),
    transitions,
  };
}

export function compileRecipe(pkg, recipe, options = {}) {
  options = options || {};
  if (!isObj(pkg)) throw new TypeError("pkg must be a package object");
  if (!isObj(recipe)) throw new TypeError("recipe must be a recipe object");
  const recipeReport = validateRecipe(recipe);
  if (!recipeReport.ok) {
    throw new TypeError(`invalid recipe: ${recipeReport.errors.map((error) => `${error.path || "/"} ${error.code}`).join(", ")}`);
  }

  const seed = assertSeed(options.seed === undefined ? 0 : options.seed);
  const variation = variationKey(options.variation);
  const fs = options.fs || DEFAULT_FS;
  const fps = Number.isInteger(options.fps) && options.fps > 0
    ? options.fps
    : (isObj(pkg.format) && Number.isInteger(pkg.format.fps) && pkg.format.fps > 0 ? pkg.format.fps : 30);

  const next = clone(pkg);
  if (!Array.isArray(next.scenes)) throw new TypeError("pkg.scenes must be an array");

  const effects = effectCatalogue(fs);
  const variationSeed = (seed ^ variation) >>> 0;

  applyTheme(next, recipe);
  applyBackgrounds(next, recipe);
  applySceneMotion(next, recipe, variationSeed);
  const plan = applySceneTransitions(next, recipe, fps, fs, variationSeed);

  const fixed = autofixMotion(next, { fps, maxPasses: 12 }).document;
  const report = validatePackage(fixed);
  if (!report.valid) {
    throw new Error(`compiled package is invalid: ${report.errors.map((error) => `${error.path || "/"} ${error.code}`).join(", ")}`);
  }
  const blocking = report.motion.filter((finding) => finding.severity === "error" || finding.severity === "warning");
  if (blocking.length > 0) {
    throw new Error(`compiled package still has motion findings: ${blocking.map((finding) => finding.code).join(", ")}`);
  }

  const look = buildLook(fixed, recipe, seed, plan, effects, fs);
  const lookReport = validateLook(look);
  if (!lookReport.ok) {
    throw new Error(`compiled look is invalid: ${lookReport.errors.map((error) => `${error.path || "/"} ${error.code}`).join(", ")}`);
  }

  return { pkg: fixed, look };
}

export default compileRecipe;
