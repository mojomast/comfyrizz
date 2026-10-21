// M06: the first twelve style recipes of spec section 3.3, checked against the table and
// against the motion lint budget. Pure read-only checks over committed JSON; no network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENERGY_TRANSITIONS, MOTION_VOCABULARY } from "../../packages/schema/src/motion.mjs";
import { ANIMATION_RECIPE_IDS } from "../../packages/schema/src/animation.mjs";
import { validateRecipe, FONT_IDS, RECIPE_SCHEMA_ID } from "./recipe-schema.mjs";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

/** Recipe ids of M06, in spec table order. */
const RECIPE_IDS = [
  "swiss-grid",
  "editorial-serif",
  "neo-brutalist",
  "kinetic-poster",
  "bauhaus-play",
  "mono-terminal",
  "blueprint",
  "isometric-saas",
  "glassmorphism",
  "clay-soft",
  "paper-collage",
  "risograph",
];

/**
 * The spec 3.3 table, compressed to the fields a regression must not silently change:
 * background hex, display/text font, easing personality, primary + accent transitions,
 * energy, story recipe and background pattern.
 *
 * Two table rows name `zoom` alongside a token from another energy family (isometric-saas
 * `slide + push, zoom` needs medium for slide but high for zoom; glassmorphism
 * `blur + fade, zoom` needs calm for blur but high for zoom), so those accents take the
 * nearest in-family stand-in (shape-reveal / cut) and the recipes run at medium / calm.
 */
const SPEC_TABLE = Object.freeze({
  "swiss-grid": {
    palette: ["#f2f0eb", "#111111", "#e3241b", "#9a9a9a"],
    fonts: { display: "space-grotesk", text: "inter" },
    personality: "editorial",
    transitions: { primary: "wipe", accent: ["push", "cut"] },
    energy: "medium",
    storyRecipe: "kinetic",
    pattern: "grid",
  },
  "editorial-serif": {
    palette: ["#faf7f2", "#1c1a17", "#b0412e", "#d9cfc1"],
    fonts: { display: "playfair-display", text: "inter" },
    personality: "editorial",
    transitions: { primary: "fade", accent: ["slide", "cut"] },
    energy: "medium",
    storyRecipe: "focus",
    pattern: "gradient",
  },
  "neo-brutalist": {
    palette: ["#fffb00", "#000000", "#ff3ea5", "#ffffff"],
    fonts: { display: "archivo-black", text: "space-grotesk" },
    personality: "snappy",
    transitions: { primary: "cut", accent: ["push", "zoom"] },
    energy: "high",
    storyRecipe: "kinetic",
    pattern: "dots",
  },
  "kinetic-poster": {
    palette: ["#0d0d0d", "#f5f5f5", "#ff5a1f", "#3a3a3a"],
    fonts: { display: "bebas-neue", text: "inter" },
    personality: "snappy",
    transitions: { primary: "push", accent: ["zoom", "cut"] },
    energy: "high",
    storyRecipe: "kinetic",
    pattern: "gradient",
  },
  "bauhaus-play": {
    palette: ["#f4efe1", "#1d1d1b", "#d6402b", "#2a5db0"],
    fonts: { display: "unbounded", text: "inter" },
    personality: "elastic",
    transitions: { primary: "shape-reveal", accent: ["slide", "wipe"] },
    energy: "medium",
    storyRecipe: "morph",
    pattern: "gradient",
  },
  "mono-terminal": {
    palette: ["#0b0f0c", "#c8facc", "#39ff88", "#4a5a4e"],
    fonts: { display: "jetbrains-mono", text: "ibm-plex-mono" },
    personality: "mechanical",
    transitions: { primary: "cut", accent: ["wipe", "fade"] },
    energy: "medium",
    storyRecipe: "technical-flow",
    pattern: "grid",
  },
  blueprint: {
    palette: ["#0f2a4a", "#e8f1fb", "#7cc4ff", "#3d6a99"],
    fonts: { display: "ibm-plex-mono", text: "inter" },
    personality: "editorial",
    transitions: { primary: "draw-reveal", accent: ["wipe", "fade"] },
    energy: "medium",
    storyRecipe: "technical-flow",
    pattern: "grid",
  },
  "isometric-saas": {
    palette: ["#0d1117", "#e6edf3", "#2d6cff", "#31d0aa"],
    fonts: { display: "space-grotesk", text: "inter" },
    personality: "snappy",
    transitions: { primary: "slide", accent: ["push", "shape-reveal"] },
    energy: "medium",
    storyRecipe: "technical-flow",
    pattern: "dots",
  },
  glassmorphism: {
    palette: ["#0b1020", "#eef3ff", "#4f6bff", "#9fe8ff"],
    fonts: { display: "syne", text: "inter" },
    personality: "floaty",
    transitions: { primary: "blur", accent: ["fade", "cut"] },
    energy: "calm",
    storyRecipe: "focus",
    pattern: "gradient",
  },
  "clay-soft": {
    palette: ["#f4e9dd", "#2b2320", "#c98a6b", "#6d4b3a"],
    fonts: { display: "fraunces", text: "inter" },
    personality: "elastic",
    transitions: { primary: "shape-reveal", accent: ["slide", "fade"] },
    energy: "medium",
    storyRecipe: "morph",
    pattern: "gradient",
  },
  "paper-collage": {
    palette: ["#fdf6e3", "#2d2a26", "#e0b13c", "#3f7d5a"],
    fonts: { display: "caveat", text: "fraunces" },
    personality: "heavy",
    transitions: { primary: "paper-reveal", accent: ["slide", "cut"] },
    energy: "medium",
    storyRecipe: "paper-cut",
    pattern: "grain",
  },
  risograph: {
    palette: ["#f6f1e7", "#1f2a5c", "#ff4f7b", "#ffd23f"],
    fonts: { display: "syne", text: "ibm-plex-mono" },
    personality: "snappy",
    transitions: { primary: "wipe", accent: ["slide", "cut"] },
    energy: "medium",
    storyRecipe: "kinetic",
    pattern: "dots",
  },
});

function loadRecipe(id) {
  const path = join(DATA_DIR, "recipes", `${id}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadEffects() {
  return JSON.parse(readFileSync(join(DATA_DIR, "effects.json"), "utf8")).effects;
}

function roleHex(recipe, role) {
  const entry = recipe.palette.find((item) => item.role === role);
  assert.ok(entry, `${recipe.id}: palette is missing the ${role} role`);
  return entry.hex.toLowerCase();
}

// WCAG 2.x relative luminance and contrast ratio (https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html).
function srgbChannel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const int = Number.parseInt(hex.slice(1), 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const recipes = RECIPE_IDS.map((id) => {
  const recipe = loadRecipe(id);
  return { id, recipe };
});

test("all twelve M06 recipe files exist, match their id and pass validateRecipe", () => {
  assert.equal(recipes.length, 12);
  for (const { id, recipe } of recipes) {
    assert.equal(recipe.id, id, `${id}.json must declare its own id`);
    const result = validateRecipe(recipe);
    assert.equal(
      result.ok,
      true,
      `${id} failed validateRecipe: ${result.errors.map((e) => `${e.path} ${e.code} (${e.message})`).join("; ")}`,
    );
    assert.equal(recipe.schema, RECIPE_SCHEMA_ID);
  }
});

test("every palette's text colour meets WCAG AA contrast against its background (>= 4.5)", () => {
  for (const { id, recipe } of recipes) {
    const background = roleHex(recipe, "background");
    const text = roleHex(recipe, "text");
    const ratio = contrastRatio(text, background);
    assert.ok(
      ratio >= 4.5,
      `${id}: text ${text} on background ${background} is ${ratio.toFixed(2)}:1, needs >= 4.5:1`,
    );
  }
});

test("no two recipes share both background colour and display font", () => {
  const seen = new Map();
  for (const { id, recipe } of recipes) {
    const background = roleHex(recipe, "background");
    const key = `${background}|${recipe.fonts.display}`;
    assert.equal(seen.has(key), false, `${id} collides with ${seen.get(key)} on background ${background} + display ${recipe.fonts.display}`);
    seen.set(key, id);
  }
});

test("primary and accent transitions stay inside the energy family and the 3-type budget", () => {
  for (const { id, recipe } of recipes) {
    const { energy } = recipe.taxonomy;
    const family = ENERGY_TRANSITIONS[energy];
    assert.ok(family, `${id}: unknown energy ${energy}`);
    const types = [recipe.transitions.primary, ...recipe.transitions.accent];
    for (const type of types) {
      assert.ok(
        MOTION_VOCABULARY.transitionTypes.includes(type),
        `${id}: ${type} is not a schema transition type`,
      );
      assert.ok(
        family.includes(type),
        `${id}: ${type} is outside the ${energy} energy family (${family.join(", ")})`,
      );
    }
    const distinct = new Set(types);
    assert.ok(distinct.size <= 3, `${id}: primary+accent name ${distinct.size} types, budget is 3`);
    assert.ok(types.length >= 1, `${id}: needs a primary transition`);
  }
});

test("font ids exist in the spec 5.1 manifest and easing tokens match the personality table", () => {
  const PERSONALITY_TOKENS = Object.freeze({
    snappy: { entry: "enter", exit: "exit", spring: "snap" },
    editorial: { entry: "enter", exit: "exit", spring: "settle" },
    elastic: { entry: "land", exit: "exit", spring: "elastic" },
    floaty: { entry: "move", exit: "exit", spring: "settle" },
    mechanical: { entry: "linear", exit: "linear", spring: "snap" },
    heavy: { entry: "land", exit: "exit", spring: "heavy" },
    anticipate: { entry: "land", exit: "exit", spring: "pop" },
  });
  for (const { id, recipe } of recipes) {
    for (const [slot, font] of Object.entries(recipe.fonts)) {
      assert.ok(FONT_IDS.includes(font), `${id}: fonts.${slot} ${font} is not a spec 5.1 font id`);
    }
    const expected = PERSONALITY_TOKENS[recipe.easing.personality];
    assert.ok(expected, `${id}: unknown easing personality ${recipe.easing.personality}`);
    assert.equal(recipe.easing.entry, expected.entry, `${id}: ${recipe.easing.personality} entry`);
    assert.equal(recipe.easing.exit, expected.exit, `${id}: ${recipe.easing.personality} exit`);
    assert.equal(recipe.easing.spring, expected.spring, `${id}: ${recipe.easing.personality} spring`);
  }
});

test("recipes stay faithful to the spec 3.3 table (palette, fonts, grammar, story, background)", () => {
  for (const { id, recipe } of recipes) {
    const row = SPEC_TABLE[id];
    assert.ok(row, `${id} has no spec table row in this test`);
    const palette = recipe.palette.map((entry) => entry.hex.toLowerCase());
    assert.deepEqual(palette, row.palette, `${id}: palette must follow the table order bg/text/accent/extra`);
    assert.equal(recipe.fonts.display, row.fonts.display, `${id}: display font`);
    assert.equal(recipe.fonts.text, row.fonts.text, `${id}: text font`);
    assert.equal(recipe.easing.personality, row.personality, `${id}: easing personality`);
    assert.equal(recipe.transitions.primary, row.transitions.primary, `${id}: primary transition`);
    assert.deepEqual(recipe.transitions.accent, row.transitions.accent, `${id}: accent transitions`);
    assert.equal(recipe.taxonomy.energy, row.energy, `${id}: energy`);
    assert.equal(recipe.storyRecipe, row.storyRecipe, `${id}: story recipe`);
    assert.equal(recipe.background.pattern, row.pattern, `${id}: background pattern`);
  }
});

test("entries, emphasis, story recipes, finish ids and prompt budgets stay in vocabulary", () => {
  const effectIds = new Set(loadEffects().map((effect) => effect.id));
  for (const { id, recipe } of recipes) {
    assert.ok(recipe.entries.length >= 1, `${id}: needs at least one entry`);
    for (const entry of recipe.entries) {
      assert.ok(MOTION_VOCABULARY.entries.includes(entry), `${id}: unknown entry ${entry}`);
    }
    for (const kind of recipe.emphasis) {
      assert.ok(MOTION_VOCABULARY.emphasis.includes(kind), `${id}: unknown emphasis ${kind}`);
    }
    assert.ok(ANIMATION_RECIPE_IDS.includes(recipe.storyRecipe), `${id}: unknown story recipe`);
    assert.ok(recipe.finish.length >= 1, `${id}: needs a finish stack`);
    for (const step of recipe.finish) {
      const effectId = typeof step === "string" ? step : step.id;
      assert.ok(effectIds.has(effectId), `${id}: finish effect ${effectId} is not in effects.json`);
    }
    assert.ok(recipe.prompt.length <= 240, `${id}: prompt is ${recipe.prompt.length} chars`);
    assert.ok(recipe.rules.do.length >= 1 && recipe.rules.dont.length >= 1, `${id}: needs do and dont rules`);
  }
});
