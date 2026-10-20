// MOTION-UPGRADE M05: transitions catalog and native fallbacks.
// Pure module: no side effects at import time, injected deps (fs, clock, rng),
// deterministic for a given seed, no network or GPU. Reads data/transitions.json
// and resolves each id to a schema-valid { type, direction?, frames } using the
// bands from packages/schema/src/motion.mjs TRANSITIONS at a given fps.

import { TRANSITIONS, MOTION_VOCABULARY } from "../../packages/schema/src/motion.mjs";

const DATA_PATH = new URL("./data/transitions.json", import.meta.url);

const GRAMMARS = Object.freeze(["cut", "wipe", "mask", "morph", "depth", "overlay", "match", "fade"]);

const DEFAULT_FPS = 30;
const MIT_ONLY = "MIT";

function readData(fs) {
  const text = fs.readFileSync(new URL(DATA_PATH), "utf8");
  return JSON.parse(text);
}

function findEntry(entries, id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error(`unknown transition id: ${id}`);
  return entry;
}

function round(x) {
  return Math.floor(x + 0.5);
}

function bandFor(type, fps) {
  const spec = TRANSITIONS[type];
  if (!spec) throw new Error(`unknown schema transition type: ${type}`);
  return { min: round(spec.minSeconds * fps), max: round(spec.maxSeconds * fps) };
}

function clampFrames(type, frames, fps) {
  const { min, max } = bandFor(type, fps);
  if (frames < min) return min;
  if (frames > max) return max;
  return frames;
}

function framesFor(entry, fps) {
  const { native, frames } = entry;
  if (native === "cut" || native === "none") return 0;
  return clampFrames(native, frames === undefined ? 15 : frames, fps);
}

function directionFor(entry) {
  const { native, direction } = entry;
  const spec = TRANSITIONS[native];
  if (!spec || !spec.axis) return undefined;
  if (direction === undefined || direction === null) {
    return spec.axis === "planar" ? MOTION_VOCABULARY.directions[0] : MOTION_VOCABULARY.transitionDirections[0];
  }
  if (spec.axis === "planar" && !MOTION_VOCABULARY.directions.includes(direction)) {
    throw new Error(`invalid planar direction ${direction} for ${native}`);
  }
  if (spec.axis === "depth" && !MOTION_VOCABULARY.transitionDirections.slice(4).includes(direction)) {
    throw new Error(`invalid depth direction ${direction} for ${native}`);
  }
  return direction;
}

function validateEntry(entry) {
  if (!GRAMMARS.includes(entry.grammar)) {
    throw new Error(`bad grammar ${entry.grammar} for ${entry.id}`);
  }
  const native = entry.native;
  if (!TRANSITIONS[native]) {
    throw new Error(`native ${native} is not a schema transition type for ${entry.id}`);
  }
  if (native === "cut" || native === "none") {
    if (entry.frames !== undefined && entry.frames !== 0) {
      throw new Error(`${native} must have frames 0 for ${entry.id}`);
    }
  }
  if (entry.glsl && entry.glsl.license !== MIT_ONLY) {
    throw new Error(`glsl shader for ${entry.id} is not MIT: ${entry.glsl.license}`);
  }
  return entry;
}

function loadCatalog(fs) {
  const data = readData(fs);
  if (data.schema !== "comfyrizz.transitions/v1") throw new Error("bad transitions schema");
  return data.entries.map(validateEntry);
}

export function listTransitions(fs) {
  return loadCatalog(fs).map((e) => ({ id: e.id, label: e.label, grammar: e.grammar, native: e.native }));
}

export function getTransition(fs, id) {
  return validateEntry(findEntry(loadCatalog(fs), id));
}

export function resolveTransition(id, { fs, fps = DEFAULT_FPS, webgl = false } = {}) {
  if (!fs) throw new Error("resolveTransition requires an injected fs");
  if (!Number.isInteger(fps) || fps <= 0) throw new Error("fps must be a positive integer");
  const entry = validateEntry(findEntry(loadCatalog(fs), id));
  const type = entry.native;
  const frames = framesFor(entry, fps);
  const out = { type, frames };
  const direction = directionFor(entry);
  if (direction !== undefined) out.direction = direction;
  if (webgl && entry.glsl) out.glsl = { name: entry.glsl.name, license: entry.glsl.license };
  if (entry.sfx) out.sfx = entry.sfx;
  if (entry.overlayEffect) out.overlayEffect = entry.overlayEffect;
  return out;
}

export function validateCatalog(fs) {
  const entries = loadCatalog(fs);
  const ids = new Set();
  for (const e of entries) {
    if (ids.has(e.id)) throw new Error(`duplicate transition id: ${e.id}`);
    ids.add(e.id);
  }
  return { ok: true, count: entries.length };
}

export default { listTransitions, getTransition, resolveTransition, validateCatalog };
