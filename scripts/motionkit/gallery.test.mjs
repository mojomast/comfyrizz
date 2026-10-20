// M13: Demo gallery generator tests
// Acceptance criteria:
// - 24 cards
// - html has no external URLs
// - regeneration is byte-identical
// - gallery.json licences subset of allowlist
// - no secret values in code, tests or output

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readRecipes, renderIndexHtml, computeLicences } from "./gallery.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths: __dirname is scripts/motionkit/, so two .. reaches repo root
const GALLERY_JSON_PATH = join(__dirname, "..", "..", "docs", "motion-gallery", "gallery.json");
const INDEX_HTML_PATH = join(__dirname, "..", "..", "docs", "motion-gallery", "index.html");

// ---- test: gallery.json has exactly 24 entries ----
test("gallery.json has exactly 24 entries", () => {
  const recipes = readRecipes();
  assert.equal(recipes.length, 24, `Expected 24 recipes, got ${recipes.length}`);
});

// ---- test: every entry has required fields ----
test("every gallery entry has required fields", () => {
  const recipes = readRecipes();
  for (const r of recipes) {
    assert.ok(r.id, "entry missing id");
    assert.ok(r.label, `entry missing label: ${JSON.stringify(r)}`);
    assert.ok(r.taxonomy, "entry missing taxonomy");
    assert.ok(r.taxonomy.energy, `entry ${r.id} missing energy`);
    assert.ok(r.taxonomy.finish, `entry ${r.id} missing finish`);
    assert.ok(r.fonts, `entry ${r.id} missing fonts`);
    assert.ok(Array.isArray(r.licences), `entry ${r.id} licences not an array`);
  }
});

// ---- test: licences are subset of allowlist ----
test("gallery.json licences subset of allowlist", () => {
  const recipes = readRecipes();
  const allowed = new Set(["MIT", "ISC", "CC0-1.0", "OFL-1.1"]);
  for (const r of recipes) {
    for (const lic of r.licences) {
      assert.ok(allowed.has(lic), `licence ${lic} not in allowlist for ${r.id}`);
    }
  }
});

// ---- test: index.html has no external URLs ----
test("index.html has no external URLs", () => {
  const html = readFileSync(INDEX_HTML_PATH, "utf8");
  const externalUrlPattern = /https?:\/\/[^\s"'<>]+/g;
  const matches = html.match(externalUrlPattern) || [];
  // The only URL that should appear is the SVG namespace
  const svgNamespace = "http://www.w3.org/2000/svg";
  const otherUrls = matches.filter((m) => m !== svgNamespace);
  assert.deepEqual(otherUrls, [], `Found external URLs in index.html: ${JSON.stringify(matches)}`);
  // Also check no raw https:// other than the SVG namespace
  const lines = html.split("\n");
  for (const line of lines) {
    const urlMatch = line.match(/https?:\/\/[^\s"'<>]+/);
    if (urlMatch && urlMatch[0] !== svgNamespace) {
      assert.fail(`index.html contains non-SVG external URL: ${urlMatch[0]}`);
    }
  }
});

// ---- test: regeneration is byte-identical ----
test("regeneration is byte-identical", () => {
  // Run the gallery generator twice and compare outputs
  const recipes1 = readRecipes();
  const content1Json = JSON.stringify(recipes1, null, 2);
  const content1Html = renderIndexHtml(recipes1);

  // "Restore" by re-running readRecipes (which reads from fixed filenames)
  const recipes2 = readRecipes();
  const content2Json = JSON.stringify(recipes2, null, 2);
  const content2Html = renderIndexHtml(recipes2);

  assert.equal(content1Json, content2Json, "gallery.json not byte-identical across runs");
  assert.equal(content1Html, content2Html, "index.html not byte-identical across runs");
});

// ---- test: no secret values in gallery.json ----
test("no secret values in gallery.json", () => {
  const json = readFileSync(GALLERY_JSON_PATH, "utf8");
  const forbidden = ["/home", "/workspace", "tailnet", "SECRET", "TOKEN", "API_KEY"];
  for (const f of forbidden) {
    assert.ok(!json.includes(f), `gallery.json contains forbidden string: ${f}`);
  }
});

// ---- test: no secret values in index.html ----
test("no secret values in index.html", () => {
  const html = readFileSync(INDEX_HTML_PATH, "utf8");
  const forbidden = ["/home", "/workspace", "tailnet", "SECRET", "TOKEN", "API_KEY"];
  for (const f of forbidden) {
    assert.ok(!html.includes(f), `index.html contains forbidden string: ${f}`);
  }
});

// ---- test: computeLicences returns only allowlisted licences ----
test("computeLicences returns only allowlisted licences", () => {
  // paper-grain -> MIT
  assert.deepEqual(computeLicences([{ id: "paper-grain", params: { amount: 0.04 } }]), ["MIT"]);
  // dust-scratches + film-grain -> CC0-1.0 + MIT
  assert.deepEqual(
    computeLicences([
      { id: "dust-scratches", params: { density: 0.3, opacity: 0.5 } },
      { id: "film-grain", params: { amount: 0.18, size: 2 } },
    ]),
    ["CC0-1.0", "MIT"]
  );
  // Unknown effect id defaults to MIT
  assert.deepEqual(computeLicences([{ id: "not-a-real-effect" }]), ["MIT"]);
  // No finish -> defaults to MIT
  assert.deepEqual(computeLicences(undefined), ["MIT"]);
  // No finish array -> defaults to MIT
  assert.deepEqual(computeLicences([]), ["MIT"]);
});

// ---- test: each recipe font id resolves to a valid name ----
test("every recipe has display font family name", () => {
  const recipes = readRecipes();
  for (const r of recipes) {
    assert.ok(r.fonts.display, ` ${r.id} missing display font`);
    assert.ok(r.fonts.text, ` ${r.id} missing text font`);
  }
});

// ---- test: energy values are from the expected set ----
test("energy values are from expected set", () => {
  const validEnergies = new Set(["calm", "medium", "high"]);
  const recipes = readRecipes();
  for (const r of recipes) {
    assert.ok(validEnergies.has(r.taxonomy.energy), `invalid energy ${r.taxonomy.energy} for ${r.id}`);
  }
});

// ---- test: unique ids across all entries ----
test("all recipe ids are unique", () => {
  const recipes = readRecipes();
  const ids = recipes.map((r) => r.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, `Duplicate ids found`);
});

// ---- test: each entry has a non-empty label ----
test("every entry has a non-empty label", () => {
  const recipes = readRecipes();
  for (const r of recipes) {
    assert.ok(r.label.trim().length > 0, `entry ${r.id} has empty label`);
  }
});