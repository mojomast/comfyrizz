import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validatePackage, ENERGY_TRANSITIONS, MOTION_VOCABULARY, ANIMATION_RECIPES } from "../../packages/schema/src/index.mjs";
import { validateLook, validateRecipe } from "./recipe-schema.mjs";
import { compileRecipe } from "./compile.mjs";

const fixtureUrl = new URL("../../packages/schema/fixtures/valid/motion-fields.json", import.meta.url);
const recipeUrl = (id) => new URL(`./data/recipes/${id}.json`, import.meta.url);

const readJson = (url) => JSON.parse(readFileSync(url, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

const fixture = readJson(fixtureUrl);
const recipes = ["swiss-grid", "cinematic-noir", "y2k-chrome"].map((id) => readJson(recipeUrl(id)));
const blocking = (report) => report.motion.filter((finding) => finding.severity === "error" || finding.severity === "warning");

test("compiles three recipes to valid packages with no motion errors or warnings", () => {
  for (const recipe of recipes) {
    assert.equal(validateRecipe(recipe).ok, true, `${recipe.id} fixture is valid`);
    const input = clone(fixture);
    const { pkg, look } = compileRecipe(input, recipe, { seed: 20261020, variation: 0 });
    const report = validatePackage(pkg);
    assert.equal(report.valid, true, `${recipe.id}: ${JSON.stringify(report.errors)}`);
    assert.deepEqual(blocking(report), [], `${recipe.id} motion warnings`);
    assert.deepEqual(validateLook(look), { ok: true, errors: [] }, `${recipe.id} look`);
    assert.deepEqual(input, fixture, `${recipe.id} does not mutate the package`);
  }
});

test("same seed and variation produce identical output", () => {
  const recipe = recipes[0];
  const first = compileRecipe(fixture, recipe, { seed: 7, variation: "a" });
  const second = compileRecipe(fixture, recipe, { seed: 7, variation: "a" });
  assert.deepEqual(second, first);
  const third = compileRecipe(fixture, recipe, { seed: 8, variation: "a" });
  assert.notDeepEqual(third.pkg, first.pkg);
});

test("compiled fields stay inside the recipe and the schema vocabulary", () => {
  const recipe = recipes[0];
  const { pkg, look } = compileRecipe(fixture, recipe, { seed: 11, variation: 2 });
  const palette = recipe.palette.map((entry) => entry.hex);
  assert.deepEqual(pkg.theme.palette, palette);
  assert.equal(pkg.theme.text, recipe.palette.find((entry) => entry.role === "text").hex);

  const story = ANIMATION_RECIPES.find((entry) => entry.id === recipe.storyRecipe);
  let heroes = 0;
  for (const scene of pkg.scenes) {
    assert.equal(scene.motion.energy, recipe.taxonomy.energy);
    assert.ok(MOTION_VOCABULARY.entries.includes(scene.motion.entry), `${scene.id} entry`);
    assert.ok(MOTION_VOCABULARY.emphasis.includes(scene.motion.emphasis), `${scene.id} emphasis`);
    if (scene.motion.emphasis === "hero") heroes += 1;
    if (scene.motion.emphasis === "keyword") assert.equal(typeof scene.motion.highlight, "string");
    if (scene.motion.recipe !== undefined) {
      assert.equal(scene.motion.recipe, recipe.storyRecipe);
      assert.ok(story.layouts.includes(scene.layout), `${scene.id} layout supports the story recipe`);
    }
    assert.ok(ENERGY_TRANSITIONS[recipe.taxonomy.energy].includes(scene.transitionOut.type), `${scene.id} transition energy`);
    if (scene.background && scene.background.procedural && scene.background.asset === undefined) {
      assert.equal(scene.background.procedural.pattern, recipe.background.pattern);
    }
  }
  assert.equal(heroes, 1, "exactly one hero moment");

  assert.equal(look.recipeId, recipe.id);
  assert.equal(look.seed, 11);
  assert.ok(look.fonts.length >= 2);
  assert.deepEqual(look.finish.map((entry) => entry.id), recipe.finish.map((entry) => entry.id));
  assert.equal(look.transitions.length, pkg.scenes.length);
  assert.ok(look.transitions.some((entry) => entry.glsl && entry.glsl.license === "MIT"));
  assert.ok(look.transitions.some((entry) => typeof entry.overlay === "string"));
});

test("invalid recipes are refused before the package is touched", () => {
  const bad = { ...recipes[0], id: "Not Kebab" };
  const input = clone(fixture);
  assert.throws(() => compileRecipe(input, bad, { seed: 1 }), /invalid recipe/);
  assert.deepEqual(input, fixture);
});

test("one-scene packages still compile and validate", () => {
  const minimal = readJson(new URL("../../packages/schema/fixtures/valid/minimal.json", import.meta.url));
  const { pkg, look } = compileRecipe(minimal, recipes[1], { seed: 3 });
  assert.equal(validatePackage(pkg).valid, true);
  assert.deepEqual(blocking(validatePackage(pkg)), []);
  assert.deepEqual(validateLook(look), { ok: true, errors: [] });
  assert.equal(look.transitions.length, 1);
});
