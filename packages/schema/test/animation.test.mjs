// ANIM: shared storytelling capabilities - schema bounds, catalogue parity and focus semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANIMATION_RECIPES,
  ANIMATION_RECIPE_IDS,
  ANIMATION_REVEAL_TRANSITIONS,
  ANIMATION_TRANSITIONS,
  LAYOUTS,
  MOTION_VOCABULARY,
  TRANSITIONS,
  lintMotion,
  loadSchema,
  validatePackage,
} from "../src/index.mjs";
import { motionBase } from "./motion-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defs = loadSchema().$defs;
const withMotion = (mutate) => {
  const doc = motionBase();
  mutate(doc.scenes[0].motion, doc);
  return doc;
};

const RECIPE_IDS = ["sketch", "paper-cut", "morph", "technical-flow", "focus", "kinetic"];

// ---------------------------------------------------------------- catalogue <-> schema

test("the recipe catalogue ids are exactly the schema enum, in a stable order", () => {
  assert.deepEqual(defs.sceneMotion.properties.recipe.enum, RECIPE_IDS);
  assert.deepEqual(ANIMATION_RECIPE_IDS, RECIPE_IDS);
  assert.deepEqual(ANIMATION_RECIPES.map((recipe) => recipe.id), RECIPE_IDS);
});

test("the transition catalogue is the vocabulary and every reveal has no direction axis", () => {
  assert.deepEqual(defs.transitionType.enum, MOTION_VOCABULARY.transitionTypes);
  assert.deepEqual(ANIMATION_TRANSITIONS, MOTION_VOCABULARY.transitionTypes);
  assert.deepEqual(ANIMATION_REVEAL_TRANSITIONS, ["paper-reveal", "draw-reveal", "shape-reveal"]);
  assert.deepEqual(Object.keys(TRANSITIONS), MOTION_VOCABULARY.transitionTypes);
  for (const id of ANIMATION_REVEAL_TRANSITIONS) assert.equal(TRANSITIONS[id].axis, null, `${id} has no axis`);
});

test("every recipe entry is documented and names only real layouts", () => {
  for (const recipe of ANIMATION_RECIPES) {
    assert.deepEqual(Object.keys(recipe).sort(), ["description", "id", "label", "layouts"], recipe.id);
    assert.ok(recipe.label.trim().length > 0, recipe.id);
    assert.ok(recipe.description.trim().length > 0, recipe.id);
    assert.ok(recipe.layouts.length > 0, `${recipe.id} has meaningful layouts`);
    assert.equal(new Set(recipe.layouts).size, recipe.layouts.length, `${recipe.id} layouts are unique`);
    for (const layout of recipe.layouts) assert.ok(layout in LAYOUTS, `${recipe.id}: unknown layout ${layout}`);
  }
  assert.equal(new Set(ANIMATION_RECIPE_IDS).size, ANIMATION_RECIPE_IDS.length);
  assert.equal(new Set(ANIMATION_TRANSITIONS).size, ANIMATION_TRANSITIONS.length);
});

test("the catalogue module is browser-safe (no imports or node built-ins)", () => {
  const source = readFileSync(join(here, "..", "src", "animation.mjs"), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /node:/);
  assert.doesNotMatch(source, /require\(/);
});

// ---------------------------------------------------------------- scene.motion fields

test("the new motion fields validate and stay optional", () => {
  const fieldCase = withMotion((motion) => {
    motion.recipe = "morph";
    motion.seed = 2147483647;
    motion.intensity = 1;
    motion.focus = { x: 0, y: 0, width: 1, height: 1 };
    motion.morph = { from: "circle", to: "blob" };
    motion.cue_phrases = ["first phrase", "second phrase"];
    motion.cue_seconds = [0.5, 2];
  });
  assert.equal(validatePackage(fieldCase).valid, true, JSON.stringify(validatePackage(fieldCase).errors));

  const legacy = motionBase();
  delete legacy.scenes[0].motion;
  assert.equal(validatePackage(legacy).valid, true, "a scene without the new fields is unchanged");
  assert.equal(validatePackage(motionBase()).valid, true);
});

test("bounds and unknown recipe/morph values are schema errors", () => {
  const cases = [
    ["unknown recipe", (m) => (m.recipe = "doodle")],
    ["seed zero", (m) => (m.seed = 0)],
    ["seed too large", (m) => (m.seed = 2147483648)],
    ["seed not an integer", (m) => (m.seed = 4.2)],
    ["intensity below 0", (m) => (m.intensity = -0.01)],
    ["intensity above 1", (m) => (m.intensity = 1.01)],
    ["focus missing width", (m) => (m.focus = { x: 0.1, y: 0.1, height: 0.2 })],
    ["focus width zero", (m) => (m.focus = { x: 0.1, y: 0.1, width: 0, height: 0.2 })],
    ["focus x negative", (m) => (m.focus = { x: -0.1, y: 0.1, width: 0.2, height: 0.2 })],
    ["focus height above 1", (m) => (m.focus = { x: 0.1, y: 0.1, width: 0.2, height: 1.2 })],
    ["focus extra key", (m) => (m.focus = { x: 0.1, y: 0.1, width: 0.2, height: 0.2, unit: "px" })],
    ["morph unknown shape", (m) => (m.morph = { from: "circle", to: "star" })],
    ["morph missing to", (m) => (m.morph = { from: "circle" })],
    ["blank cue phrase", (m) => (m.cue_phrases = [""])],
    ["too many cue phrases", (m) => (m.cue_phrases = ["a", "b", "c", "d", "e", "f", "g"])],
    ["cue_seconds negative", (m) => (m.cue_seconds = [-1])],
  ];
  for (const [name, mutate] of cases) {
    assert.equal(validatePackage(withMotion(mutate)).schemaOk, false, name);
  }
});

test("a focus rectangle that leaves the frame is a semantic error, not silent clipping", () => {
  const doc = withMotion((motion) => (motion.focus = { x: 0.8, y: 0.2, width: 0.5, height: 0.4 }));
  const result = validatePackage(doc);
  assert.equal(result.schemaOk, true, "each bound is individually valid");
  assert.equal(result.valid, false);
  assert.deepEqual(result.semantic.map((finding) => [finding.code, finding.path]), [
    ["SEM_MOTION_FOCUS_RECT", "/scenes/0/motion/focus"],
  ]);
});

// ---------------------------------------------------------------- transitions

test("the reveal transitions accept the documented duration bands and no direction", () => {
  const bands = {
    "paper-reveal": [9, 24],
    "draw-reveal": [11, 27],
    "shape-reveal": [8, 18],
  };
  for (const [type, [min, max]] of Object.entries(bands)) {
    const doc = motionBase();
    const scene = doc.scenes[0];
    scene.transitionOut = { type, frames: min };
    assert.equal(validatePackage(doc).valid, true, `${type} min band`);
    scene.transitionOut = { type, frames: max };
    assert.equal(validatePackage(doc).valid, true, `${type} max band`);
    scene.transitionOut = { type, frames: max + 1 };
    const findings = lintMotion(doc).filter((finding) => finding.code === "MOTION_TRANSITION_DURATION");
    assert.equal(findings.length, 1, `${type} above band warns`);
    assert.equal(findings[0].path, "/scenes/0/transitionOut/frames");

    scene.transitionOut = { type, frames: 15, direction: "left" };
    const direction = lintMotion(doc).find((finding) => finding.code === "MOTION_DIRECTION_UNUSED");
    assert.ok(direction, `${type} has no direction axis`);
  }
});
