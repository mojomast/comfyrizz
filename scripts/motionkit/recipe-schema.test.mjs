import test from "node:test";
import assert from "node:assert/strict";

import { MOTION_VOCABULARY, ENERGY_TRANSITIONS } from "../../packages/schema/src/motion.mjs";
import { ANIMATION_RECIPE_IDS } from "../../packages/schema/src/animation.mjs";
import {
  validateRecipe,
  validateLook,
  BACKGROUND_PATTERNS,
  FONT_IDS,
  RECIPE_SCHEMA_ID,
  LOOK_SCHEMA_ID,
} from "./recipe-schema.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

function recipe(overrides = {}) {
  return {
    schema: RECIPE_SCHEMA_ID,
    id: "swiss-grid",
    label: "Swiss grid",
    taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "grotesk" },
    palette: [
      { role: "background", hex: "#f2f0eb" },
      { role: "text", hex: "#111111" },
      { role: "accent", hex: "#e3241b" },
      { role: "muted", hex: "#9a9a9a" },
    ],
    fonts: { display: "space-grotesk", text: "inter", mono: "jetbrains-mono" },
    easing: { personality: "editorial", entry: "enter", exit: "exit", spring: "settle" },
    entries: ["maskRise", "fadeUp", "waterfall"],
    emphasis: ["keyword", "hero"],
    transitions: { primary: "wipe", accent: ["push", "cut"] },
    storyRecipe: "kinetic",
    background: { pattern: "grid" },
    finish: [{ id: "paper-grain", params: { amount: 0.04 } }],
    rules: { do: ["flush-left headlines on a 12-col grid"], dont: ["centered text", "drop shadows"] },
    prompt: "Swiss International Style poster, strict grid, red accent, flat colour, no gradients",
    ...overrides,
  };
}

function look(overrides = {}) {
  return {
    schema: LOOK_SCHEMA_ID,
    recipeId: "swiss-grid",
    seed: 42,
    fonts: [
      { family: "space-grotesk", assetId: "aSpaceGrotesk" },
      { family: "inter", assetId: "aInter" },
    ],
    finish: [{ id: "paper-grain", params: { amount: 0.04 }, cpuFallback: true }],
    transitions: [{ scene: "sIntro", id: "linear-wipe", native: "wipe", overlay: "whoosh-soft" }],
    camera: { move: "push-in", amount: 0.06 },
    ...overrides,
  };
}

function paths(result) {
  return result.errors.map((error) => error.path);
}

function assertRejected(result, path) {
  assert.equal(result.ok, false, "expected the document to be rejected");
  assert.ok(paths(result).includes(path), `expected an error at ${path}; got ${JSON.stringify(paths(result))}`);
}

test("a valid recipe and look pass", () => {
  assert.deepEqual(validateRecipe(recipe()), { ok: true, errors: [] });
  assert.deepEqual(validateLook(look()), { ok: true, errors: [] });
});

test("recipe root and id are validated", () => {
  assertRejected(validateRecipe(null), "");
  assertRejected(validateRecipe(recipe({ schema: "comfyrizz.recipe/v2" })), "/schema");
  assertRejected(validateRecipe(recipe({ id: "Swiss Grid" })), "/id");
  assertRejected(validateRecipe(recipe({ id: "swiss_grid" })), "/id");
  assertRejected(validateRecipe(recipe({ label: "" })), "/label");
});

test("unknown transitions are rejected with their JSON path", () => {
  const primary = recipe();
  primary.transitions.primary = "dissolve";
  assertRejected(validateRecipe(primary), "/transitions/primary");

  const accent = recipe();
  accent.transitions.accent = ["push", "crossfade"];
  assertRejected(validateRecipe(accent), "/transitions/accent/1");
});

test("transitions must sit inside the recipe energy family and budget", () => {
  const outside = recipe();
  outside.taxonomy.energy = "calm";
  outside.transitions.primary = "zoom";
  assertRejected(validateRecipe(outside), "/transitions/primary");

  const budget = recipe();
  budget.transitions = { primary: "wipe", accent: ["push", "slide", "cut"] };
  assertRejected(validateRecipe(budget), "/transitions");
});

test("unknown entries, emphasis, springs and eases are rejected", () => {
  assertRejected(validateRecipe(recipe({ entries: ["maskRise", "fadeIn"] })), "/entries/1");
  assertRejected(validateRecipe(recipe({ emphasis: ["spotlight"] })), "/emphasis/0");
  assertRejected(validateRecipe(recipe({ easing: { personality: "editorial", entry: "enter", exit: "exit", spring: "bouncy" } })), "/easing/spring");
  assertRejected(validateRecipe(recipe({ easing: { personality: "editorial", entry: "enter", exit: "swish", spring: "settle" } })), "/easing/exit");
  assertRejected(validateRecipe(recipe({ easing: { personality: "editorial", entry: "swish", exit: "exit", spring: "settle" } })), "/easing/entry");
  assertRejected(validateRecipe(recipe({ easing: { personality: "wobbly", entry: "enter", exit: "exit", spring: "settle" } })), "/easing/personality");
});

test("palette must hold 4-6 #rrggbb colours with roles", () => {
  const three = recipe();
  three.palette = three.palette.slice(0, 3);
  assertRejected(validateRecipe(three), "/palette");

  const seven = recipe();
  seven.palette = [
    ...seven.palette,
    { role: "surface", hex: "#ffffff" },
    { role: "highlight", hex: "#ffff00" },
    { role: "shadow", hex: "#000000" },
  ];
  assertRejected(validateRecipe(seven), "/palette");

  const shortHex = recipe();
  shortHex.palette[1].hex = "#111";
  assertRejected(validateRecipe(shortHex), "/palette/1/hex");

  const missingRole = recipe();
  missingRole.palette[1].role = "background";
  assertRejected(validateRecipe(missingRole), "/palette/1/role");
});

test("fonts, story recipe, background, finish, rules and prompt are validated", () => {
  assertRejected(validateRecipe(recipe({ fonts: { display: "comic-sans", text: "inter" } })), "/fonts/display");
  assertRejected(validateRecipe(recipe({ storyRecipe: "explainer" })), "/storyRecipe");
  assertRejected(validateRecipe(recipe({ background: { pattern: "static" } })), "/background/pattern");
  assertRejected(validateRecipe(recipe({ finish: [{ id: "Paper Grain" }] })), "/finish/0/id");
  assertRejected(validateRecipe(recipe({ rules: { do: ["x"], dont: [42] } })), "/rules/dont/0");
  assertRejected(validateRecipe(recipe({ prompt: "x".repeat(241) })), "/prompt");
});

test("vocabulary tokens are imported from packages/schema, not copied", () => {
  for (const entry of MOTION_VOCABULARY.entries) {
    const variant = recipe({ entries: [entry] });
    assert.equal(validateRecipe(variant).ok, true, `entry ${entry} from MOTION_VOCABULARY should be accepted`);
  }
  for (const ease of MOTION_VOCABULARY.easing) {
    const variant = recipe({ easing: { personality: "editorial", entry: ease, exit: ease, spring: "settle" } });
    assert.equal(validateRecipe(variant).ok, true, `ease ${ease} from MOTION_VOCABULARY should be accepted`);
  }
  for (const spring of MOTION_VOCABULARY.springs) {
    const variant = recipe({ easing: { personality: "editorial", entry: "enter", exit: "exit", spring } });
    assert.equal(validateRecipe(variant).ok, true, `spring ${spring} from MOTION_VOCABULARY should be accepted`);
  }
  for (const type of MOTION_VOCABULARY.transitionTypes) {
    const energy = Object.keys(ENERGY_TRANSITIONS).find((name) => ENERGY_TRANSITIONS[name].includes(type));
    assert.ok(energy, `transition ${type} should belong to an energy family`);
    const variant = recipe({ taxonomy: { era: "modernist", finish: "clean", energy, geometry: "flat", type: "grotesk" }, transitions: { primary: type, accent: [] } });
    assert.equal(validateRecipe(variant).ok, true, `transition ${type} from MOTION_VOCABULARY should be accepted`);
  }
  for (const story of ANIMATION_RECIPE_IDS) {
    const variant = recipe({ storyRecipe: story });
    assert.equal(validateRecipe(variant).ok, true, `story recipe ${story} from ANIMATION_RECIPE_IDS should be accepted`);
  }
  for (const pattern of BACKGROUND_PATTERNS) {
    const variant = recipe({ background: { pattern } });
    assert.equal(validateRecipe(variant).ok, true, `background pattern ${pattern} from the package schema should be accepted`);
  }
  for (const font of FONT_IDS) {
    const variant = recipe({ fonts: { display: font, text: font } });
    assert.equal(validateRecipe(variant).ok, true, `font id ${font} should be accepted`);
  }
});

test("look sidecar rejects an unknown native transition, seed and camera", () => {
  const badNative = look();
  badNative.transitions[0].native = "crossfade";
  assertRejected(validateLook(badNative), "/transitions/0/native");

  assertRejected(validateLook(look({ schema: "comfyrizz.look/v2" })), "/schema");
  assertRejected(validateLook(look({ seed: -1 })), "/seed");
  assertRejected(validateLook(look({ seed: 1.5 })), "/seed");
  assertRejected(validateLook(look({ fonts: [{ family: "", assetId: "aComic" }] })), "/fonts/0/family");
  assertRejected(validateLook(look({ fonts: [{ family: "inter", assetId: "inter" }] })), "/fonts/0/assetId");
  assertRejected(validateLook(look({ finish: [{ id: "grain", params: [] }] })), "/finish/0/params");
  assertRejected(validateLook(look({ camera: { move: "push-in", amount: "a lot" } })), "/camera/amount");
});

test("validation is pure and does not mutate its input", () => {
  const input = recipe();
  const snapshot = clone(input);
  validateRecipe(input);
  assert.deepEqual(input, snapshot);

  const bad = recipe({ id: "Not Kebab" });
  const badSnapshot = clone(bad);
  validateRecipe(bad);
  assert.deepEqual(bad, badSnapshot);
});
