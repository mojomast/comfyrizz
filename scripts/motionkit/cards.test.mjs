// M15 acceptance: skill front matter format, recipe card length, catalog line length, no URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RECIPES,
  recipeCard,
  catalogCard,
  listRecipeIds,
} from "./cards.mjs";

const SKILL_PATH = "../../packages/agent/src/skills/motion-style/SKILL.md";
const skillSource = readFileSync(new URL(SKILL_PATH, import.meta.url), "utf8");
const skillFront = /^---\n([\s\S]*?)\n---\n/.exec(skillSource);

test("SKILL.md has front matter matching the existing skills' format", () => {
  assert.ok(skillFront, "motion-style SKILL.md must start with a front matter block");
  const body = skillFront[1];
  assert.match(body, /^name: motion-style$/m, "name must equal motion-style");
  assert.match(body, /^  version: "1\.0\.0"$/m, "version must be semver");
  assert.match(body, /^description: .+$/m, "description must be present");
  assert.match(skillSource, /^---\n[\s\S]*?\n---\n# /m, "front matter must be followed by a title");
});

test("SKILL.md front matter parses like the other skills", () => {
  const metadata = new Map();
  for (const line of skillFront[1].split("\n")) {
    if (line === "metadata:") continue;
    const field = /^(name|description): (.+)$/.exec(line) ?? /^  (version): "([^"]+)"$/.exec(line);
    assert.ok(field, `unexpected front matter line: ${line}`);
    assert.ok(!metadata.has(field[1]), `duplicate front matter field: ${field[1]}`);
    metadata.set(field[1], field[2]);
  }
  assert.equal(metadata.get("name"), "motion-style");
  assert.match(metadata.get("version"), /^\d+\.\d+\.\d+$/);
  assert.ok(metadata.get("description"));
});

test("there are 24 recipes", () => {
  assert.equal(listRecipeIds().length, 24);
  assert.equal(listRecipeIds().filter((id) => RECIPES.find((r) => r.id === id)).length, 24);
});

test("each recipe card is at most 1400 characters", () => {
  for (const recipe of RECIPES) {
    const card = recipeCard(recipe);
    assert.ok(card.length <= 1400, `${recipe.id}: card is ${card.length} chars (limit 1400)`);
    assert.ok(card.length > 0, `${recipe.id}: card must not be empty`);
  }
});

test("each recipe card with an effects catalog is at most 1400 characters", () => {
  const effects = [
    { id: "paper-grain", label: "Paper grain" },
    { id: "bloom", label: "Bloom" },
    { id: "vignette-soft", label: "Soft vignette" },
  ];
  for (const recipe of RECIPES) {
    const card = recipeCard(recipe, effects);
    assert.ok(card.length <= 1400, `${recipe.id}: card with effects is ${card.length} chars (limit 1400)`);
  }
});

test("recipe cards contain no URLs", () => {
  const urlRegex = /https?:\/\//;
  for (const recipe of RECIPES) {
    const card = recipeCard(recipe);
    assert.ok(!urlRegex.test(card), `${recipe.id}: card must not contain URLs`);
  }
});

test("catalog lines are at most 120 characters", () => {
  const catalog = catalogCard(RECIPES);
  for (const line of catalog.split("\n")) {
    assert.ok(line.length <= 120, `catalog line too long: ${line.length} chars: ${line}`);
  }
  assert.equal(catalog.split("\n").length, RECIPES.length, "one line per recipe");
});

test("catalog contains no URLs", () => {
  assert.ok(!/https?:\/\//.test(catalogCard(RECIPES)), "catalog must not contain URLs");
});

test("recipe card includes palette roles, type pair, easing, transitions, finish and do/don't", () => {
  const card = recipeCard(RECIPES[0]);
  assert.ok(/Palette:/.test(card), "card should list palette roles");
  assert.ok(/Type pair:/.test(card), "card should list the type pair");
  assert.ok(/Easing:/.test(card), "card should list easing");
  assert.ok(/Transitions:/.test(card), "card should list transitions");
  assert.ok(/Finish:/.test(card), "card should list finish");
  assert.ok(/Do:/.test(card), "card should list do rules");
  assert.ok(/Don't:/.test(card), "card should list don't rules");
});

test("catalogCard with no recipes returns an empty string", () => {
  assert.equal(catalogCard([]), "");
});
