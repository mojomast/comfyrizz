// IL01H: an optional boolean `hero` on the package scene, so IL01G can feed real
// package data to isHeroShot/pickForShot. Absent means not flagged; it has no default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDefaults, loadSchema, validatePackage } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const fixture = (rel) => JSON.parse(readFileSync(join(pkgDir, "fixtures", rel), "utf8"));

const BASE = "valid/minimal.json";

function heroErrors(value) {
  const doc = fixture(BASE);
  doc.scenes[0].hero = value;
  return validatePackage(doc).errors.filter((e) => e.source === "schema");
}

test("the schema publishes an optional boolean hero with no default", () => {
  const prop = loadSchema().$defs.scene.properties.hero;
  assert.ok(prop, "scene.hero is missing from the schema");
  assert.equal(prop.type, "boolean");
  assert.equal("default" in prop, false, "hero must not have a default");
  assert.match(prop.description, /hero shot/i);
  assert.match(prop.description, /Balanced video pick 'hero'/);
  assert.match(prop.description, /first and last shots are the heroes/);
  assert.match(prop.description, /layout 'hero'/);
  assert.match(prop.description, /motion\.emphasis 'hero'/);
});

test("hero: true validates", () => {
  const doc = fixture(BASE);
  doc.scenes[0].hero = true;
  const result = validatePackage(doc);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("hero: false validates", () => {
  const doc = fixture(BASE);
  doc.scenes[0].hero = false;
  const result = validatePackage(doc);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

for (const [label, value] of [
  ["a string", "yes"],
  ["a number", 1],
  ["null", null],
]) {
  test(`hero: ${label} is a structural schema error at /scenes/0/hero`, () => {
    const errors = heroErrors(value);
    assert.ok(
      errors.some((e) => e.path === "/scenes/0/hero"),
      `expected an error at /scenes/0/hero, got ${JSON.stringify(errors)}`,
    );
  });
}

test("applyDefaults never adds hero to scenes that do not flag it", () => {
  const doc = fixture("valid/defaults-unfilled.json");
  assert.ok(doc.scenes.length > 0);
  const filled = applyDefaults(doc, loadSchema());
  for (const [i, scene] of filled.scenes.entries()) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(scene, "hero"),
      false,
      `scene ${i} gained a hero key`,
    );
  }
  assert.equal(
    Object.prototype.hasOwnProperty.call(doc.scenes[0], "hero"),
    false,
    "applyDefaults mutated its input",
  );
});

test("the generated Scene interface exposes hero?: boolean", () => {
  const types = readFileSync(join(pkgDir, "types.ts"), "utf8");
  const start = types.indexOf("export interface Scene ");
  assert.notEqual(start, -1, "Scene interface missing from types.ts");
  const next = types.indexOf("\n\nexport ", start);
  const block = types.slice(start, next === -1 ? undefined : next);
  assert.match(block, /^\s*hero\?: boolean;$/m);
});
