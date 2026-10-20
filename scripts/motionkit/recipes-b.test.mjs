// MOTION-UPGRADE M07: recipes 13-24 of spec section 3.3.
//
// Runs from the repo root with `node --test scripts/motionkit/recipes-b.test.mjs`.
// Pure: reads only the twelve recipe files in data/recipes, no network, clock or randomness.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateRecipe } from "./recipe-schema.mjs";
import { ENERGY_TRANSITIONS } from "../../packages/schema/src/motion.mjs";

const RECIPE_DIR = new URL("./data/recipes/", import.meta.url);

const RECIPE_IDS = [
  "cinematic-noir",
  "film-35mm",
  "vhs-retro",
  "crt-arcade",
  "y2k-chrome",
  "synthwave",
  "vaporwave",
  "organic-hand",
  "data-journalism",
  "luxury-minimal",
  "neon-cyber",
  "documentary-archive",
];

const loadRecipe = (id) => JSON.parse(readFileSync(new URL(`${id}.json`, RECIPE_DIR), "utf8"));

const RECIPES = RECIPE_IDS.map((id) => ({ id, recipe: loadRecipe(id) }));

// --- WCAG contrast, computed here rather than copied -------------------------------

function channel(hex, index) {
  return parseInt(hex.slice(index, index + 2), 16) / 255;
}

function channelLuminance(value) {
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const r = channelLuminance(channel(hex, 1));
  const g = channelLuminance(channel(hex, 3));
  const b = channelLuminance(channel(hex, 5));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const high = Math.max(la, lb);
  const low = Math.min(la, lb);
  return (high + 0.05) / (low + 0.05);
}

const role = (recipe, name) => recipe.palette.find((entry) => entry.role === name);

// --- taxonomy distance -----------------------------------------------------------

const TAXONOMY_KEYS = ["era", "finish", "energy", "geometry", "type"];

function taxonomyDistance(a, b) {
  let differences = 0;
  for (const key of TAXONOMY_KEYS) if (a[key] !== b[key]) differences += 1;
  return differences / TAXONOMY_KEYS.length;
}

test("every recipe passes validateRecipe and its id matches its filename", () => {
  assert.equal(RECIPES.length, 12, "recipes 13-24 must all be present");
  const ids = new Set();
  for (const { id, recipe } of RECIPES) {
    assert.equal(recipe.id, id, `file ${id}.json must declare id "${id}"`);
    assert.ok(!ids.has(id), `duplicate recipe id ${id}`);
    ids.add(id);
    const result = validateRecipe(recipe);
    assert.deepEqual(result, { ok: true, errors: [] }, `${id} must validate: ${JSON.stringify(result.errors)}`);
  }
});

test("palette text-on-background contrast is at least 4.5", () => {
  for (const { id, recipe } of RECIPES) {
    const background = role(recipe, "background");
    const text = role(recipe, "text");
    assert.ok(background && text, `${id} needs background and text roles`);
    const ratio = contrastRatio(text.hex, background.hex);
    assert.ok(ratio >= 4.5, `${id} text on background contrast ${ratio.toFixed(2)} is below 4.5`);
  }
});

test("recipes are pairwise distinct from each other", () => {
  for (let i = 0; i < RECIPES.length; i += 1) {
    for (let j = i + 1; j < RECIPES.length; j += 1) {
      const a = RECIPES[i];
      const b = RECIPES[j];
      const sameBackground = role(a.recipe, "background").hex === role(b.recipe, "background").hex;
      const sameDisplay = a.recipe.fonts.display === b.recipe.fonts.display;
      assert.ok(
        !(sameBackground && sameDisplay),
        `${a.id} and ${b.id} share both background colour and display font`,
      );
      const distance = taxonomyDistance(a.recipe.taxonomy, b.recipe.taxonomy);
      assert.ok(
        distance >= 0.2,
        `${a.id} and ${b.id} taxonomy distance ${distance.toFixed(2)} is below 0.2`,
      );
    }
  }
});

test("transitions stay inside the energy family and the three-type budget", () => {
  for (const { id, recipe } of RECIPES) {
    const energy = recipe.taxonomy.energy;
    const family = ENERGY_TRANSITIONS[energy];
    assert.ok(family, `${id} has unknown energy ${energy}`);

    const types = new Set([recipe.transitions.primary, ...recipe.transitions.accent]);
    for (const type of types) {
      assert.ok(
        family.includes(type),
        `${id} transition ${type} is outside the ${energy} energy family (${family.join(", ")})`,
      );
    }
    assert.ok(types.size <= 3, `${id} names ${types.size} transition types; the budget is 3`);
  }
});
