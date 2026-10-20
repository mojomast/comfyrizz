// MS2: the motion vocabulary of comfyrizz.package/v1 and a pure motion linter.
//
// The vocabulary names are exactly the token names of the renderer's motion library (MS1,
// apps/renderer/src/motion/index.js and primitives.js), so the renderer can look a field up
// without a translation table; test/motion.test.mjs imports the renderer tokens and fails if
// the two ever drift. The numbers (reading holds, transition budget, vector law, one hero
// moment, durations per transition family) are re-expressed from `whaleyxbt/claude-motion`
// (MIT, Copyright (c) 2026 whaleyxbt) and the HyperFrames motion skills (Apache-2.0,
// Copyright HeyGen) as summarised in research/RESEARCH_MOTION_SKILLS.md sections 4.2 and 4.5.
// No code was copied.
//
// lintMotion() is advisory: it never changes validity (validatePackage() reports it under
// `motion`, next to errors and warnings). Every finding is
//   { code, severity: "error" | "warning" | "info", scene, path, message, autofix, source: "motion" }
// where `autofix` is null or { description, ops: [{ op: "set", path, value } | { op: "delete", path }] }
// over JSON-pointer paths. applyMotionFixes() applies them; autofixMotion() lints, fixes and
// re-lints until nothing fixable is left.
//
// pipeline-py/comfyrizz_pipeline/motion_lint.py implements the same rules; the conformance test
// compares code, severity, scene, path and autofix over a shared set of cases.

export const MOTION_VOCABULARY = Object.freeze({
  easing: Object.freeze(["enter", "exit", "move", "land", "linear"]),
  springs: Object.freeze(["settle", "heavy", "snap", "pop", "elastic"]),
  energies: Object.freeze(["calm", "medium", "high"]),
  directions: Object.freeze(["left", "right", "up", "down"]),
  staggers: Object.freeze(["none", "word", "listItem", "dot"]),
  entries: Object.freeze(["none", "fadeUp", "maskRise", "pop", "countUp", "waterfall", "drawOn"]),
  emphasis: Object.freeze(["none", "keyword", "hero"]),
  transitionTypes: Object.freeze(["none", "cut", "fade", "blur", "slide", "push", "wipe", "zoom", "iris", "paper-reveal", "draw-reveal", "shape-reveal"]),
  transitionDirections: Object.freeze(["left", "right", "up", "down", "in", "out"]),
});

/**
 * Each transition type: which directions it takes (`planar` = left/right/up/down, `depth` =
 * in/out, null = none) and its duration band in seconds (research 4.5: calm 0.5-0.8 s, medium
 * 0.3-0.5 s, high 0.15-0.3 s, iris 0.3-0.35 s; the bands are a little wider than the ideal so
 * the default 15-frame fade at 24-30 fps is in band).
 */
export const TRANSITIONS = Object.freeze({
  none: Object.freeze({ axis: null, minSeconds: 0, maxSeconds: 0 }),
  cut: Object.freeze({ axis: null, minSeconds: 0, maxSeconds: 0 }),
  fade: Object.freeze({ axis: null, minSeconds: 0.3, maxSeconds: 0.8 }),
  blur: Object.freeze({ axis: null, minSeconds: 0.4, maxSeconds: 0.8 }),
  slide: Object.freeze({ axis: "planar", minSeconds: 0.25, maxSeconds: 0.6 }),
  push: Object.freeze({ axis: "planar", minSeconds: 0.25, maxSeconds: 0.6 }),
  wipe: Object.freeze({ axis: "planar", minSeconds: 0.25, maxSeconds: 0.6 }),
  zoom: Object.freeze({ axis: "depth", minSeconds: 0.15, maxSeconds: 0.4 }),
  iris: Object.freeze({ axis: "depth", minSeconds: 0.25, maxSeconds: 0.45 }),
  // Storytelling reveals (animation research 2026 section 4): no travel axis, so a
  // direction on them is MOTION_DIRECTION_UNUSED. Bands leave room for a drawn or
  // paper motion without letting a reveal become a scene-long effect.
  "paper-reveal": Object.freeze({ axis: null, minSeconds: 0.3, maxSeconds: 0.8 }),
  "draw-reveal": Object.freeze({ axis: null, minSeconds: 0.35, maxSeconds: 0.9 }),
  "shape-reveal": Object.freeze({ axis: null, minSeconds: 0.25, maxSeconds: 0.6 }),
});

/** The transition family each energy reads as (research 4.5). Outside it is an info finding. */
export const ENERGY_TRANSITIONS = Object.freeze({
  calm: Object.freeze(["none", "cut", "fade", "blur", "paper-reveal", "draw-reveal"]),
  medium: Object.freeze(["none", "cut", "fade", "slide", "push", "wipe", "paper-reveal", "draw-reveal", "shape-reveal"]),
  high: Object.freeze(["none", "cut", "push", "zoom", "iris", "shape-reveal"]),
});

/** Mirrors ENERGY_PROFILES and STAGGER_SECONDS of the renderer (checked by a test). */
export const ENERGY_SCALES = Object.freeze({
  calm: Object.freeze({ entryScale: 1.2, staggerScale: 1.15 }),
  medium: Object.freeze({ entryScale: 1, staggerScale: 1 }),
  high: Object.freeze({ entryScale: 0.8, staggerScale: 0.75 }),
});
export const STAGGER_STEP_SECONDS = Object.freeze({ none: 0, word: 0.09, listItem: 0.22, dot: 0.06 });

export const MOTION_DEFAULTS = Object.freeze({
  energy: "medium",
  direction: "left",
  depthDirection: "in",
  transition: Object.freeze({ type: "fade", frames: 15 }),
  fps: 30,
});

/** Reading-hold rule (research 4.2): >= 1 s + 0.25 s per word beyond three; >= 2 s at the end. */
export const READING = Object.freeze({
  minHoldSeconds: 1,
  freeWords: 3,
  perExtraWordSeconds: 0.25,
  finalHoldSeconds: 2,
  entrySeconds: 0.6,
  maxStaggerSeconds: 0.5,
});

/** At most this many distinct transition types per film (one primary + one or two accents). */
export const MAX_TRANSITION_TYPES = 3;

export const MOTION_LINT_CODES = Object.freeze({
  MOTION_CUT_HAS_FRAMES: "error",
  MOTION_DIRECTION_AXIS: "error",
  MOTION_HIGHLIGHT_MISSING: "error",
  MOTION_HIGHLIGHT_NOT_IN_COPY: "error",
  MOTION_DIRECTION_UNUSED: "warning",
  MOTION_TRANSITION_DURATION: "warning",
  MOTION_TRANSITION_BUDGET: "warning",
  MOTION_DIRECTION_PINGPONG: "warning",
  MOTION_HERO_MULTIPLE: "warning",
  MOTION_ELASTIC_REPEAT: "warning",
  MOTION_LINEAR_ENTRY: "warning",
  MOTION_ENTRY_MISMATCH: "warning",
  MOTION_READING_HOLD: "warning",
  MOTION_FINAL_HOLD: "warning",
  MOTION_AGAINST_CURRENT: "info",
  MOTION_HERO_EARLY: "info",
  MOTION_NO_HERO: "info",
  MOTION_ENERGY_MISMATCH: "info",
});

const OPPOSITE = Object.freeze({ left: "right", right: "left", up: "down", down: "up", in: "out", out: "in" });
const PLANAR = new Set(["left", "right", "up", "down"]);
const DEPTH = new Set(["in", "out"]);
const COPY_FIELDS = ["headline", "kicker", "sub", "body", "quote", "attribution", "footnote", "cta"];
const VECTOR_KINDS = new Set(["svg", "vector-anim"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const round = (v) => Math.floor(v + 0.5); // same as Python's floor(x + 0.5), unlike banker's round()

function finding(code, scene, path, message, autofix = null) {
  return { code, severity: MOTION_LINT_CODES[code], scene, path, message, autofix, source: "motion" };
}

function fix(description, ...ops) {
  return { description, ops };
}

function words(text) {
  return isStr(text) ? text.split(/\s+/).filter((w) => w.length > 0) : [];
}

/** Every piece of on-screen copy a viewer has to read in this scene. */
function readableText(scene) {
  const out = [];
  const copy = isObj(scene.copy) ? scene.copy : {};
  for (const field of COPY_FIELDS) if (isStr(copy[field])) out.push(copy[field]);
  if (Array.isArray(copy.items)) for (const item of copy.items) if (isStr(item)) out.push(item);
  if (isObj(scene.lower_third)) {
    if (isStr(scene.lower_third.kicker)) out.push(scene.lower_third.kicker);
    if (isStr(scene.lower_third.text)) out.push(scene.lower_third.text);
  }
  return out;
}

function packageMotion(doc) {
  const m = isObj(doc.motion) ? doc.motion : {};
  return {
    energy: MOTION_VOCABULARY.energies.includes(m.energy) ? m.energy : MOTION_DEFAULTS.energy,
    direction: MOTION_VOCABULARY.directions.includes(m.direction) ? m.direction : MOTION_DEFAULTS.direction,
  };
}

function sceneEnergy(scene, pkg) {
  const m = isObj(scene.motion) ? scene.motion : {};
  return MOTION_VOCABULARY.energies.includes(m.energy) ? m.energy : pkg.energy;
}

/** The transition a scene really has: a missing transitionOut is the default fade. */
function transitionOf(scene) {
  const t = scene.transitionOut;
  if (!isObj(t)) return { type: MOTION_DEFAULTS.transition.type, frames: MOTION_DEFAULTS.transition.frames, direction: undefined, explicit: false };
  const type = isStr(t.type) && TRANSITIONS[t.type] ? t.type : null;
  const frames = isInt(t.frames) ? t.frames : MOTION_DEFAULTS.transition.frames;
  return { type, frames, direction: isStr(t.direction) ? t.direction : undefined, explicit: true };
}

/** Direction a directional transition travels in once defaults are applied, or null. */
function resolvedDirection(tr, pkg) {
  const spec = tr.type ? TRANSITIONS[tr.type] : null;
  if (!spec || !spec.axis) return null;
  if (spec.axis === "planar") return PLANAR.has(tr.direction) ? tr.direction : pkg.direction;
  return DEPTH.has(tr.direction) ? tr.direction : MOTION_DEFAULTS.depthDirection;
}

function band(type, fps) {
  const spec = TRANSITIONS[type];
  return { min: round(spec.minSeconds * fps), max: round(spec.maxSeconds * fps) };
}

function clampFrames(type, frames, fps) {
  const { min, max } = band(type, fps);
  return frames < min ? min : frames > max ? max : frames;
}

function sceneLabel(scene, index) {
  return isStr(scene.id) ? scene.id : `#${index}`;
}

/**
 * Frames a scene is on screen: the compiled timeline when given (the truth after narration and
 * target-duration fitting), otherwise `preferredFrames`; null when neither is known.
 */
function sceneFrames(scene, timeline) {
  if (isObj(timeline) && Array.isArray(timeline.scenes)) {
    const hit = timeline.scenes.find((s) => isObj(s) && s.id === scene.id);
    if (hit && isInt(hit.durationInFrames)) return hit.durationInFrames;
  }
  return isInt(scene.preferredFrames) ? scene.preferredFrames : null;
}

/** Seconds from scene start until its copy has settled (entry + capped stagger). */
function settleSeconds(scene, pkg) {
  const m = isObj(scene.motion) ? scene.motion : {};
  const scales = ENERGY_SCALES[sceneEnergy(scene, pkg)];
  if (m.entry === "none") return 0;
  const entry = READING.entrySeconds * scales.entryScale;
  let family = MOTION_VOCABULARY.staggers.includes(m.stagger) ? m.stagger : null;
  if (family === null) family = scene.layout === "list" && scene.variant === "bullets" ? "listItem" : "none";
  const copy = isObj(scene.copy) ? scene.copy : {};
  let count = 0;
  if (family === "listItem") count = Array.isArray(copy.items) ? copy.items.length : 0;
  else if (family === "word") count = words(isStr(copy.headline) ? copy.headline : copy.quote).length;
  const stagger = Math.min(READING.maxStaggerSeconds, Math.max(0, count - 1) * STAGGER_STEP_SECONDS[family] * scales.staggerScale);
  return entry + stagger;
}

/**
 * Lint the motion of a package. Pure; never throws on malformed input.
 * @param {object} doc a comfyrizz.package/v1 document
 * @param {{ fps?: number, timeline?: { scenes: Array<{ id: string, durationInFrames: number }> } }} [options]
 * @returns {Array<{code: string, severity: string, scene: string|null, path: string, message: string, autofix: null|{description: string, ops: object[]}, source: "motion"}>}
 */
export function lintMotion(doc, options = {}) {
  if (!isObj(doc) || !Array.isArray(doc.scenes)) return [];
  const fps = isInt(options.fps) && options.fps > 0 ? options.fps : isObj(doc.format) && isInt(doc.format.fps) && doc.format.fps > 0 ? doc.format.fps : MOTION_DEFAULTS.fps;
  const pkg = packageMotion(doc);
  const scenes = doc.scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => isObj(scene));
  const out = [];
  const last = scenes.length ? scenes[scenes.length - 1].index : -1;
  const transitions = new Map(); // index -> resolved transition of every non-final scene

  // --- per-transition rules -----------------------------------------------------------
  for (const { scene, index } of scenes) {
    const at = `/scenes/${index}`;
    const label = sceneLabel(scene, index);
    if (index === last) continue; // the final scene's transitionOut has no next scene to go to
    const tr = transitionOf(scene);
    if (!tr.type) continue; // an unknown type is a schema error, not a motion finding
    transitions.set(index, tr);
    const spec = TRANSITIONS[tr.type];
    if (tr.type === "cut" && tr.frames > 0) {
      out.push(finding("MOTION_CUT_HAS_FRAMES", label, `${at}/transitionOut/frames`, `a cut has no overlap; frames must be 0 (got ${tr.frames})`, fix("set the cut's frames to 0", { op: "set", path: `${at}/transitionOut/frames`, value: 0 })));
    }
    if (tr.direction !== undefined) {
      if (!spec.axis) {
        out.push(finding("MOTION_DIRECTION_UNUSED", label, `${at}/transitionOut/direction`, `a ${tr.type} has no direction (got ${JSON.stringify(tr.direction)})`, fix("drop the direction", { op: "delete", path: `${at}/transitionOut/direction` })));
      } else if ((spec.axis === "planar" && !PLANAR.has(tr.direction)) || (spec.axis === "depth" && !DEPTH.has(tr.direction))) {
        const value = spec.axis === "planar" ? pkg.direction : MOTION_DEFAULTS.depthDirection;
        const allowed = spec.axis === "planar" ? "left, right, up or down" : "in or out";
        out.push(finding("MOTION_DIRECTION_AXIS", label, `${at}/transitionOut/direction`, `a ${tr.type} goes ${allowed} (got ${JSON.stringify(tr.direction)})`, fix(`set the direction to ${value}`, { op: "set", path: `${at}/transitionOut/direction`, value })));
      }
    }
    if (tr.type !== "none" && tr.type !== "cut") {
      const { min, max } = band(tr.type, fps);
      if (tr.frames < min || tr.frames > max) {
        const value = clampFrames(tr.type, tr.frames, fps);
        const autofix = tr.explicit
          ? fix(`set frames to ${value}`, { op: "set", path: `${at}/transitionOut/frames`, value })
          : fix(`write the default ${tr.type} out with ${value} frames`, { op: "set", path: `${at}/transitionOut`, value: { type: tr.type, frames: value } });
        out.push(finding("MOTION_TRANSITION_DURATION", label, `${at}/transitionOut/frames`, `a ${tr.type} runs ${min}-${max} frames at ${fps} fps (got ${tr.frames})`, autofix));
      }
    }
    const energy = sceneEnergy(scene, pkg);
    if (!ENERGY_TRANSITIONS[energy].includes(tr.type)) {
      out.push(finding("MOTION_ENERGY_MISMATCH", label, `${at}/transitionOut/type`, `a ${tr.type} does not read as ${energy} energy (${energy}: ${ENERGY_TRANSITIONS[energy].filter((t) => t !== "none").join(", ")})`));
    }
  }

  // --- film-level transition rules: budget and vector law --------------------------------
  const order = [...transitions.keys()].sort((a, b) => a - b);
  const counts = new Map();
  for (const index of order) {
    const { type } = transitions.get(index);
    if (type === "none" || type === "cut") continue;
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  if (counts.size > MAX_TRANSITION_TYPES) {
    // Map iteration is first-seen order, so a stable sort by count breaks ties by first use.
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
    const keep = new Set(ranked.slice(0, MAX_TRANSITION_TYPES));
    const primary = ranked[0];
    for (const index of order) {
      const tr = transitions.get(index);
      if (tr.type === "none" || tr.type === "cut" || keep.has(tr.type)) continue;
      const scene = doc.scenes[index];
      const value = { type: primary, frames: clampFrames(primary, tr.frames, fps) };
      out.push(finding("MOTION_TRANSITION_BUDGET", sceneLabel(scene, index), `/scenes/${index}/transitionOut/type`, `${counts.size} transition types in one film; keep ${MAX_TRANSITION_TYPES} (${ranked.slice(0, MAX_TRANSITION_TYPES).join(", ")}) and use the primary ${primary} here instead of ${tr.type}`, fix(`use the primary transition ${primary}`, { op: "set", path: `/scenes/${index}/transitionOut`, value })));
    }
  }
  let previous = null; // { index, direction } of the previous transition when it was directional
  for (const index of order) {
    const tr = transitions.get(index);
    const scene = doc.scenes[index];
    const direction = resolvedDirection(tr, pkg);
    if (direction && previous && previous.index === index - 1 && OPPOSITE[previous.direction] === direction) {
      out.push(finding("MOTION_DIRECTION_PINGPONG", sceneLabel(scene, index), `/scenes/${index}/transitionOut/direction`, `goes ${direction} right after a transition that went ${previous.direction}; keep one current`, fix(`go ${previous.direction} like the transition before`, { op: "set", path: `/scenes/${index}/transitionOut/direction`, value: previous.direction })));
    } else if (direction && TRANSITIONS[tr.type].axis === "planar" && (direction === "left" || direction === "right") && direction === OPPOSITE[pkg.direction]) {
      out.push(finding("MOTION_AGAINST_CURRENT", sceneLabel(scene, index), `/scenes/${index}/transitionOut/direction`, `goes ${direction} against the film's current (${pkg.direction})`));
    }
    previous = direction ? { index, direction } : null;
  }

  // --- per-scene motion presets --------------------------------------------------------
  const heroes = [];
  const elastic = [];
  let directed = isObj(doc.motion);
  for (const { scene, index } of scenes) {
    const at = `/scenes/${index}`;
    const label = sceneLabel(scene, index);
    if (!isObj(scene.motion)) continue;
    directed = true;
    const m = scene.motion;
    if (m.emphasis === "hero") heroes.push(index);
    if (m.spring === "elastic") elastic.push(index);
    if (m.ease === "linear" && m.entry !== "none") {
      out.push(finding("MOTION_LINEAR_ENTRY", label, `${at}/motion/ease`, "linear is for continuous motion; an entrance eases", fix("use the enter ease", { op: "set", path: `${at}/motion/ease`, value: "enter" })));
    }
    if (m.emphasis === "keyword" && !isStr(m.highlight)) {
      out.push(finding("MOTION_HIGHLIGHT_MISSING", label, `${at}/motion/highlight`, "a keyword emphasis needs the word or phrase to highlight", fix("drop the keyword emphasis", { op: "set", path: `${at}/motion/emphasis`, value: "none" })));
    }
    if (isStr(m.highlight)) {
      const needle = m.highlight.toLowerCase();
      const found = readableText(scene).some((text) => text.toLowerCase().includes(needle));
      if (!found) {
        const ops = [{ op: "delete", path: `${at}/motion/highlight` }];
        if (m.emphasis === "keyword") ops.push({ op: "set", path: `${at}/motion/emphasis`, value: "none" });
        out.push(finding("MOTION_HIGHLIGHT_NOT_IN_COPY", label, `${at}/motion/highlight`, `${JSON.stringify(m.highlight)} is not in this scene's copy`, fix("drop the highlight", ...ops)));
      }
    }
    if (m.entry === "countUp" && !(isObj(scene.data) && isStr(scene.data.dataset))) {
      out.push(finding("MOTION_ENTRY_MISMATCH", label, `${at}/motion/entry`, "countUp counts a dataset value; this scene has no data.dataset", fix("use the layout's default entry", { op: "delete", path: `${at}/motion/entry` })));
    }
    if (m.entry === "drawOn" && !hasVectorArt(scene, doc)) {
      out.push(finding("MOTION_ENTRY_MISMATCH", label, `${at}/motion/entry`, "drawOn draws SVG strokes; this scene has no svg or vector-anim asset", fix("use the layout's default entry", { op: "delete", path: `${at}/motion/entry` })));
    }
  }
  if (heroes.length > 1) {
    // Build to the hero moment: keep the last one, the others become ordinary scenes.
    const keep = heroes[heroes.length - 1];
    for (const index of heroes.slice(0, -1)) {
      out.push(finding("MOTION_HERO_MULTIPLE", sceneLabel(doc.scenes[index], index), `/scenes/${index}/motion/emphasis`, `one hero moment per film; ${sceneLabel(doc.scenes[keep], keep)} keeps it`, fix("drop this hero emphasis", { op: "set", path: `/scenes/${index}/motion/emphasis`, value: "none" })));
    }
  } else if (heroes.length === 1 && heroes[0] === scenes[0]?.index && scenes.length >= 3) {
    out.push(finding("MOTION_HERO_EARLY", sceneLabel(doc.scenes[heroes[0]], heroes[0]), `/scenes/${heroes[0]}/motion/emphasis`, "the hero moment is spent in the first scene; build to it"));
  } else if (heroes.length === 0 && directed && scenes.length >= 3) {
    out.push(finding("MOTION_NO_HERO", null, "/scenes", "no scene has emphasis hero; a film builds to one hero moment"));
  }
  for (const index of elastic.slice(1)) {
    out.push(finding("MOTION_ELASTIC_REPEAT", sceneLabel(doc.scenes[index], index), `/scenes/${index}/motion/spring`, "elastic is an accent: once per film", fix("use the pop spring", { op: "set", path: `/scenes/${index}/motion/spring`, value: "pop" })));
  }

  // --- reading holds ---------------------------------------------------------------------
  for (const { scene, index } of scenes) {
    const count = readableText(scene).reduce((n, text) => n + words(text).length, 0);
    if (count === 0) continue;
    const frames = sceneFrames(scene, options.timeline);
    if (frames === null) continue;
    const final = index === last;
    const tr = transitions.get(index);
    const outFrames = !final && tr && tr.type !== "none" && tr.type !== "cut" ? tr.frames : 0;
    const required = Math.max(final ? READING.finalHoldSeconds : READING.minHoldSeconds, READING.minHoldSeconds + Math.max(0, count - READING.freeWords) * READING.perExtraWordSeconds);
    const hold = frames / fps - settleSeconds(scene, pkg) - outFrames / fps;
    if (hold + 1e-9 < required) {
      const value = Math.ceil(frames + (required - hold) * fps - 1e-9);
      const code = final ? "MOTION_FINAL_HOLD" : "MOTION_READING_HOLD";
      const what = final ? "the final frame holds" : `${count} words hold`;
      out.push(finding(code, sceneLabel(scene, index), `/scenes/${index}/preferredFrames`, `${what} ${hold.toFixed(2)} s after settling; needs ${required.toFixed(2)} s`, fix(`lengthen the scene to ${value} frames`, { op: "set", path: `/scenes/${index}/preferredFrames`, value })));
    }
  }

  // Plain code-unit order (not localeCompare) so the Python mirror sorts identically.
  return out.sort((a, b) => (a.path === b.path ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.path < b.path ? -1 : 1));
}

function hasVectorArt(scene, doc) {
  const assets = isObj(doc.assets) ? doc.assets : {};
  const ids = [];
  if (isObj(scene.background) && isStr(scene.background.asset)) ids.push(scene.background.asset);
  if (Array.isArray(scene.foreground)) for (const fg of scene.foreground) if (isObj(fg) && isStr(fg.asset)) ids.push(fg.asset);
  return ids.some((id) => isObj(assets[id]) && VECTOR_KINDS.has(assets[id].kind));
}

function pointer(path) {
  return path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function applyOp(doc, op) {
  const parts = pointer(op.path);
  if (parts.length === 0) return false;
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    const key = Array.isArray(node) ? Number(part) : part;
    if (node[key] === undefined && op.op === "set") node[key] = {};
    node = node[key];
    if (node === null || typeof node !== "object") return false;
  }
  const key = Array.isArray(node) ? Number(parts.at(-1)) : parts.at(-1);
  if (op.op === "delete") {
    if (Array.isArray(node) || !(key in node)) return false;
    delete node[key];
    return true;
  }
  if (op.op === "set") {
    // A no-op set is not a change, so autofixMotion() stops instead of re-applying it.
    if (JSON.stringify(node[key]) === JSON.stringify(op.value)) return false;
    node[key] = structuredClone(op.value);
    return true;
  }
  return false;
}

/**
 * Apply the autofixes of `findings` (default: lint `doc` first) to a copy of `doc`.
 * Only findings whose severity is in `severities` are applied (default: errors and warnings;
 * info findings carry no autofix anyway).
 * @returns {{ document: object, applied: object[] }}
 */
export function applyMotionFixes(doc, findings = lintMotion(doc), { severities = ["error", "warning"] } = {}) {
  const document = structuredClone(doc);
  const applied = [];
  for (const item of findings) {
    if (!item || !item.autofix || !severities.includes(item.severity)) continue;
    let changed = false;
    for (const op of item.autofix.ops || []) changed = applyOp(document, op) || changed;
    if (changed) applied.push(item);
  }
  return { document, applied };
}

/**
 * Lint, fix and re-lint until nothing fixable is left (a fix can expose the next finding, e.g.
 * straightening one ping-pong reveals the one after it). Bounded at `maxPasses`.
 * @returns {{ document: object, applied: object[], remaining: object[], passes: number }}
 */
export function autofixMotion(doc, { maxPasses = 5, severities = ["error", "warning"], ...options } = {}) {
  let document = doc;
  const applied = [];
  let passes = 0;
  for (; passes < maxPasses; passes += 1) {
    const fixable = lintMotion(document, options).filter((f) => f.autofix && severities.includes(f.severity));
    if (fixable.length === 0) break;
    const result = applyMotionFixes(document, fixable, { severities });
    if (result.applied.length === 0) break;
    document = result.document;
    applied.push(...result.applied);
  }
  return { document, applied, remaining: lintMotion(document, options), passes };
}
