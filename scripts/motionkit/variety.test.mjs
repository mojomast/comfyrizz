import test from "node:test";
import assert from "node:assert/strict";

import { pickRecipe, sceneVariation, recipeDistance } from "./variety.mjs";
import { validateRecipe } from "./recipe-schema.mjs";

const makeRecipe = (id, overrides = {}) => {
  const base = {
    schema: "comfyrizz.recipe/v1",
    id,
    label: id,
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
    rules: { do: ["x"], dont: ["y"] },
    prompt: "test",
  };
  return { ...base, ...overrides, taxonomy: { ...base.taxonomy, ...(overrides.taxonomy || {}) }, palette: overrides.palette || base.palette };
};

const recipes = [
  makeRecipe("swiss-grid", { taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "grotesk" }, palette: [
    { role: "background", hex: "#f2f0eb" }, { role: "text", hex: "#111111" }, { role: "accent", hex: "#e3241b" }, { role: "muted", hex: "#9a9a9a" }
  ] }),
  makeRecipe("editorial-serif", { taxonomy: { era: "editorial", finish: "grain", energy: "calm", geometry: "flat", type: "serif" }, palette: [
    { role: "background", hex: "#faf7f2" }, { role: "text", hex: "#1c1a17" }, { role: "accent", hex: "#b0412e" }, { role: "muted", hex: "#d9cfc1" }
  ] }),
  makeRecipe("neo-brutalist", { taxonomy: { era: "brutalist", finish: "playful", energy: "high", geometry: "organic", type: "display" }, palette: [
    { role: "background", hex: "#fffb00" }, { role: "text", hex: "#000000" }, { role: "accent", hex: "#ff3ea5" }, { role: "muted", hex: "#ffffff" }
  ] }),
  makeRecipe("kinetic-poster", { taxonomy: { era: "poster", finish: "playful", energy: "high", geometry: "organic", type: "display" }, palette: [
    { role: "background", hex: "#0d0d0d" }, { role: "text", hex: "#f5f5f5" }, { role: "accent", hex: "#ff5a1f" }, { role: "muted", hex: "#3a3a3a" }
  ] }),
  makeRecipe("bauhaus-play", { taxonomy: { era: "bauhaus", finish: "playful", energy: "medium", geometry: "organic", type: "display" }, palette: [
    { role: "background", hex: "#f4efe1" }, { role: "text", hex: "#1d1d1b" }, { role: "accent", hex: "#d6402b" }, { role: "muted", hex: "#2a5db0" }
  ] }),
  makeRecipe("vaporwave", { taxonomy: { era: "y2k", finish: "playful", energy: "medium", geometry: "organic", type: "display" }, palette: [
    { role: "background", hex: "#2b1055" }, { role: "text", hex: "#fef6ff" }, { role: "accent", hex: "#ff71ce" }, { role: "muted", hex: "#01cdfe" }
  ] }),
];

test("recipeDistance is exported and gives taxonomy+palette distance", () => {
  const d = recipeDistance(recipes[0], recipes[1]);
  assert.ok(typeof d === "number");
  assert.ok(d >= 0 && d <= 1);
  // same recipe should be close
  const d0 = recipeDistance(recipes[0], recipes[0]);
  assert.ok(d0 < 0.1);
});

test("100 seeded picks with history never repeat within 4", () => {
  const history = [];
  const used = new Set();
  for (let i = 0; i < 100; i++) {
    const res = pickRecipe(recipes, { tone: ["serious"], goal: "explain", energy: "medium", history, seed: i * 131542391 });
    assert.ok(res.recipe, `pick ${i} should return a recipe`);
    const id = res.recipe.id;
    // check last 4
    const recent = history.slice(-4).map(h => (h.recipeId || (h.recipe && h.recipe.id)));
    assert.ok(!recent.includes(id), `recipe ${id} repeated within 4 at iteration ${i}`);
    history.push(res.historyEntry || { recipeId: id, recipe: res.recipe });
  }
});

test("tone 'playful' favours playful recipes (statistical test with fixed seeds)", () => {
  let playfulCount = 0;
  for (let s = 0; s < 50; s++) {
    const res = pickRecipe(recipes, { tone: ["playful"], goal: "promo", energy: "high", history: [], seed: 12345 + s });
    const tax = res.recipe.taxonomy || {};
    if (tax.finish === "playful" || tax.era === "y2k" || tax.geometry === "organic" || tax.energy === "high" || tax.type === "display") {
      playfulCount++;
    }
  }
  assert.ok(playfulCount >= 30, `playful count ${playfulCount}/50 should be >= 30`);
});

test("sceneVariation rotates entries/emphasis within the recipe so no 3 consecutive scenes share an entry and exactly one hero scene exists", () => {
  const recipe = recipes[0];
  const scenes = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, text: `scene ${i}` }));
  const varied = sceneVariation(recipe, scenes, 999);
  assert.equal(varied.length, scenes.length);
  // exactly one hero
  const heroes = varied.filter(s => s.emphasis === "hero");
  assert.equal(heroes.length, 1, `expected exactly one hero, got ${heroes.length}`);
  // no 3 consecutive share an entry
  for (let i = 0; i < varied.length - 2; i++) {
    const e1 = varied[i].entry;
    const e2 = varied[i+1].entry;
    const e3 = varied[i+2].entry;
    if (e1 && e2 && e3) {
      assert.ok(!(e1 === e2 && e2 === e3), `three consecutive scenes share entry ${e1} at positions ${i},${i+1},${i+2}`);
    }
  }
});

test("history passed in/out as plain JSON (no storage here)", () => {
  const history = [];
  const res = pickRecipe(recipes, { tone: ["serious"], history, seed: 1 });
  const entry = res.historyEntry;
  assert.ok(typeof entry === "object");
  // plain JSON serializable
  const json = JSON.stringify(entry);
  assert.ok(typeof json === "string");
  history.push(JSON.parse(json));
});
