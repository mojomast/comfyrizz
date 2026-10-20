// M01: validation contract for comfyrizz.recipe/v1 and the comfyrizz.look/v1 sidecar.
//
// The recipe vocabulary is imported from the package schema rather than copied, so a token
// that the renderer accepts can never drift from a token a recipe accepts. The background
// pattern enum is read from the package JSON Schema for the same reason.
//
// Pure module: no filesystem, network, clock or randomness. validateRecipe() and
// validateLook() never throw on malformed input; they return { ok, errors } where every error
// carries a JSON Pointer `path` into the input document.

import packageSchema from "../../packages/schema/package-v1.schema.json" with { type: "json" };
import { MOTION_VOCABULARY, ENERGY_TRANSITIONS } from "../../packages/schema/src/motion.mjs";
import { ANIMATION_RECIPE_IDS } from "../../packages/schema/src/animation.mjs";

export const RECIPE_SCHEMA_ID = "comfyrizz.recipe/v1";
export const LOOK_SCHEMA_ID = "comfyrizz.look/v1";

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ASSET_ID = /^a[A-Za-z0-9_-]{0,63}$/;

/** Easing personalities from spec 3.2. `nearestToken` lives in easing.mjs (M02). */
export const EASING_PERSONALITIES = Object.freeze([
  "snappy",
  "editorial",
  "elastic",
  "floaty",
  "mechanical",
  "heavy",
  "anticipate",
]);

/** Font manifest ids from spec 5.1 (M08 owns the full manifest; these are the recipe ids). */
export const FONT_IDS = Object.freeze([
  "inter",
  "jetbrains-mono",
  "space-grotesk",
  "playfair-display",
  "fraunces",
  "dm-serif-display",
  "archivo-black",
  "bebas-neue",
  "ibm-plex-mono",
  "instrument-serif",
  "syne",
  "press-start-2p",
  "caveat",
  "orbitron",
  "unbounded",
  "vt323",
  "monoton",
]);

/** The five procedural background patterns, read from the package schema enum. */
export const BACKGROUND_PATTERNS = Object.freeze([
  ...(packageSchema.$defs.background.properties.procedural.properties.pattern.enum || []),
]);

const REQUIRED_PALETTE_ROLES = Object.freeze(["background", "text", "accent"]);
const MAX_PALETTE = 6;
const MIN_PALETTE = 4;
const MAX_PROMPT = 240;
const MAX_TRANSITION_TYPES = 3;

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStr = (value) => typeof value === "string";
const isInt = (value) => typeof value === "number" && Number.isInteger(value);
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function problem(path, code, message) {
  return { path, code, message };
}

function reject(errors, path, code, message) {
  errors.push(problem(path, code, message));
}

/** Require a plain object at `path` (empty path is the document root). */
function expectObject(errors, value, path, label) {
  if (!isObj(value)) {
    reject(errors, path, "EXPECTED_OBJECT", `${label} must be an object`);
    return false;
  }
  return true;
}

/** Require a non-empty string, optionally matching a pattern and an allowed set. */
function expectString(errors, value, path, label, { pattern, allowed, maxLength } = {}) {
  if (!isStr(value) || value.length === 0) {
    reject(errors, path, "EXPECTED_STRING", `${label} must be a non-empty string`);
    return false;
  }
  if (maxLength !== undefined && value.length > maxLength) {
    reject(errors, path, "STRING_TOO_LONG", `${label} must be at most ${maxLength} characters (got ${value.length})`);
    return false;
  }
  if (pattern && !pattern.test(value)) {
    reject(errors, path, "STRING_PATTERN", `${label} must match ${pattern} (got ${JSON.stringify(value)})`);
    return false;
  }
  if (allowed && !allowed.includes(value)) {
    reject(errors, path, "UNKNOWN_TOKEN", `${label} ${JSON.stringify(value)} is not one of: ${allowed.join(", ")}`);
    return false;
  }
  return true;
}

function expectArray(errors, value, path, label) {
  if (!Array.isArray(value)) {
    reject(errors, path, "EXPECTED_ARRAY", `${label} must be an array`);
    return false;
  }
  return true;
}

function validatePalette(errors, palette) {
  if (!expectArray(errors, palette, "/palette", "palette")) return;
  if (palette.length < MIN_PALETTE || palette.length > MAX_PALETTE) {
    reject(errors, "/palette", "PALETTE_LENGTH", `palette must hold ${MIN_PALETTE}-${MAX_PALETTE} colours (got ${palette.length})`);
  }
  const roles = new Set();
  palette.forEach((entry, index) => {
    const at = `/palette/${index}`;
    if (!expectObject(errors, entry, at, "palette entry")) return;
    if (expectString(errors, entry.role, `${at}/role`, "palette role", { pattern: KEBAB })) {
      if (roles.has(entry.role)) reject(errors, `${at}/role`, "DUPLICATE_ROLE", `palette role ${JSON.stringify(entry.role)} is repeated`);
      roles.add(entry.role);
    }
    expectString(errors, entry.hex, `${at}/hex`, "palette hex", { pattern: HEX });
  });
  for (const role of REQUIRED_PALETTE_ROLES) {
    if (!roles.has(role)) reject(errors, "/palette", "PALETTE_ROLE_MISSING", `palette needs a ${role} role`);
  }
}

function validateFonts(errors, fonts) {
  if (!expectObject(errors, fonts, "/fonts", "fonts")) return;
  expectString(errors, fonts.display, "/fonts/display", "display font", { allowed: FONT_IDS });
  expectString(errors, fonts.text, "/fonts/text", "text font", { allowed: FONT_IDS });
  if (has(fonts, "mono")) expectString(errors, fonts.mono, "/fonts/mono", "mono font", { allowed: FONT_IDS });
}

function validateEasing(errors, easing) {
  if (!expectObject(errors, easing, "/easing", "easing")) return;
  expectString(errors, easing.personality, "/easing/personality", "easing personality", { allowed: EASING_PERSONALITIES });
  expectString(errors, easing.entry, "/easing/entry", "easing entry", { allowed: MOTION_VOCABULARY.easing });
  expectString(errors, easing.exit, "/easing/exit", "easing exit", { allowed: MOTION_VOCABULARY.easing });
  expectString(errors, easing.spring, "/easing/spring", "easing spring", { allowed: MOTION_VOCABULARY.springs });
}

function validateEntries(errors, entries) {
  if (!expectArray(errors, entries, "/entries", "entries")) return;
  entries.forEach((entry, index) => {
    expectString(errors, entry, `/entries/${index}`, "entry", { allowed: MOTION_VOCABULARY.entries });
  });
}

function validateEmphasis(errors, emphasis) {
  if (emphasis === undefined) return;
  if (!expectArray(errors, emphasis, "/emphasis", "emphasis")) return;
  emphasis.forEach((entry, index) => {
    expectString(errors, entry, `/emphasis/${index}`, "emphasis", { allowed: MOTION_VOCABULARY.emphasis });
  });
}

function validateTransitions(errors, transitions, energy) {
  if (!expectObject(errors, transitions, "/transitions", "transitions")) return;

  const allowedFamily = MOTION_VOCABULARY.energies.includes(energy) ? ENERGY_TRANSITIONS[energy] : null;
  const checkType = (value, path, label) => {
    const ok = expectString(errors, value, path, label, { allowed: MOTION_VOCABULARY.transitionTypes });
    if (ok && allowedFamily && !allowedFamily.includes(value)) {
      reject(errors, path, "ENERGY_TRANSITION_MISMATCH", `${label} ${JSON.stringify(value)} is outside the ${energy} energy family (${allowedFamily.join(", ")})`);
      return false;
    }
    return ok;
  };

  const types = new Set();
  const primaryOk = checkType(transitions.primary, "/transitions/primary", "primary transition");
  if (primaryOk) types.add(transitions.primary);

  if (expectArray(errors, transitions.accent, "/transitions/accent", "accent transitions")) {
    transitions.accent.forEach((value, index) => {
      if (checkType(value, `/transitions/accent/${index}`, "accent transition")) types.add(value);
    });
  }

  if (types.size > MAX_TRANSITION_TYPES) {
    reject(errors, "/transitions", "TRANSITION_BUDGET", `primary + accent may name at most ${MAX_TRANSITION_TYPES} distinct transition types (got ${types.size}: ${[...types].join(", ")})`);
  }
}

function validateFinish(errors, finish, path = "/finish") {
  if (!expectArray(errors, finish, path, "finish")) return;
  finish.forEach((effect, index) => {
    const at = `${path}/${index}`;
    if (isStr(effect)) {
      expectString(errors, effect, at, "finish effect id", { pattern: KEBAB });
      return;
    }
    if (!expectObject(errors, effect, at, "finish effect")) return;
    expectString(errors, effect.id, `${at}/id`, "finish effect id", { pattern: KEBAB });
    if (has(effect, "params") && !expectObject(errors, effect.params, `${at}/params`, "finish effect params")) return;
    if (has(effect, "cpuFallback") && typeof effect.cpuFallback !== "boolean") {
      reject(errors, `${at}/cpuFallback`, "EXPECTED_BOOLEAN", "finish cpuFallback must be a boolean");
    }
  });
}

function validateRules(errors, rules) {
  if (!expectObject(errors, rules, "/rules", "rules")) return;
  for (const key of ["do", "dont"]) {
    if (!expectArray(errors, rules[key], `/rules/${key}`, `rules ${key}`)) continue;
    rules[key].forEach((line, index) => {
      expectString(errors, line, `/rules/${key}/${index}`, `rules ${key} line`);
    });
  }
}

/**
 * Validate a comfyrizz.recipe/v1 document.
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: Array<{path: string, code: string, message: string}> }}
 */
export function validateRecipe(obj) {
  const errors = [];
  if (!expectObject(errors, obj, "", "recipe")) return { ok: false, errors };

  expectString(errors, obj.schema, "/schema", "schema", { allowed: [RECIPE_SCHEMA_ID] });
  expectString(errors, obj.id, "/id", "id", { pattern: KEBAB });
  expectString(errors, obj.label, "/label", "label");

  let energy;
  if (expectObject(errors, obj.taxonomy, "/taxonomy", "taxonomy")) {
    const taxonomy = obj.taxonomy;
    for (const key of ["era", "finish", "geometry", "type"]) {
      expectString(errors, taxonomy[key], `/taxonomy/${key}`, `taxonomy ${key}`, { pattern: KEBAB });
    }
    if (expectString(errors, taxonomy.energy, "/taxonomy/energy", "taxonomy energy", { allowed: MOTION_VOCABULARY.energies })) {
      energy = taxonomy.energy;
    }
  }

  validatePalette(errors, obj.palette);
  validateFonts(errors, obj.fonts);
  validateEasing(errors, obj.easing);
  validateEntries(errors, obj.entries);
  validateEmphasis(errors, obj.emphasis);
  validateTransitions(errors, obj.transitions, energy);

  if (has(obj, "storyRecipe")) {
    expectString(errors, obj.storyRecipe, "/storyRecipe", "storyRecipe", { allowed: ANIMATION_RECIPE_IDS });
  }

  if (expectObject(errors, obj.background, "/background", "background")) {
    expectString(errors, obj.background.pattern, "/background/pattern", "background pattern", { allowed: BACKGROUND_PATTERNS });
  }

  validateFinish(errors, obj.finish);
  validateRules(errors, obj.rules);
  expectString(errors, obj.prompt, "/prompt", "prompt", { maxLength: MAX_PROMPT });

  return finalize(errors);
}

function validateLookFonts(errors, fonts) {
  if (!expectArray(errors, fonts, "/fonts", "fonts")) return;
  fonts.forEach((font, index) => {
    const at = `/fonts/${index}`;
    if (!expectObject(errors, font, at, "look font")) return;
    expectString(errors, font.family, `${at}/family`, "look font family", { pattern: /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/ });
    expectString(errors, font.assetId, `${at}/assetId`, "look font assetId", { pattern: ASSET_ID });
  });
}

function validateLookTransitions(errors, transitions) {
  if (!expectArray(errors, transitions, "/transitions", "transitions")) return;
  transitions.forEach((transition, index) => {
    const at = `/transitions/${index}`;
    if (!expectObject(errors, transition, at, "look transition")) return;
    expectString(errors, transition.scene, `${at}/scene`, "look transition scene");
    expectString(errors, transition.id, `${at}/id`, "look transition id", { pattern: KEBAB });
    expectString(errors, transition.native, `${at}/native`, "look transition native", { allowed: MOTION_VOCABULARY.transitionTypes });
    for (const key of ["glsl", "overlay"]) {
      if (!has(transition, key)) continue;
      if (!isStr(transition[key]) && !isObj(transition[key])) {
        reject(errors, `${at}/${key}`, "EXPECTED_STRING_OR_OBJECT", `look transition ${key} must be a string or object`);
      }
    }
  });
}

function validateCamera(errors, camera) {
  if (camera === undefined) return;
  if (!expectObject(errors, camera, "/camera", "camera")) return;
  expectString(errors, camera.move, "/camera/move", "camera move", { pattern: KEBAB });
  if (!isFiniteNumber(camera.amount)) {
    reject(errors, "/camera/amount", "EXPECTED_NUMBER", "camera amount must be a finite number");
  }
}

/**
 * Validate a comfyrizz.look/v1 sidecar (spec 3.4).
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: Array<{path: string, code: string, message: string}> }}
 */
export function validateLook(obj) {
  const errors = [];
  if (!expectObject(errors, obj, "", "look")) return { ok: false, errors };

  expectString(errors, obj.schema, "/schema", "schema", { allowed: [LOOK_SCHEMA_ID] });
  expectString(errors, obj.recipeId, "/recipeId", "recipeId", { pattern: KEBAB });
  if (!isInt(obj.seed) || obj.seed < 0) {
    reject(errors, "/seed", "EXPECTED_SEED", "seed must be a non-negative integer");
  }

  validateLookFonts(errors, obj.fonts);
  validateFinish(errors, obj.finish);
  validateLookTransitions(errors, obj.transitions);
  validateCamera(errors, obj.camera);

  return finalize(errors);
}

function finalize(errors) {
  const sorted = [...errors].sort((a, b) => (a.path === b.path ? a.code.localeCompare(b.code) : a.path.localeCompare(b.path)));
  return { ok: sorted.length === 0, errors: sorted };
}
