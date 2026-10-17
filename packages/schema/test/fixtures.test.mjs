// B1 acceptance: every fixture in the shared corpus matches its declared expectation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackage, SEMANTIC_CODES, LAYOUTS } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "fixtures");
const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
const load = (rel) => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8"));

test("the corpus is big enough to mean something", () => {
  assert.ok(manifest.fixtures.length >= 30, `only ${manifest.fixtures.length} fixtures`);
  assert.ok(manifest.fixtures.filter((f) => f.kind === "invalid").length >= 25);
  assert.ok(manifest.fixtures.filter((f) => f.kind === "valid").length >= 4);
});

for (const entry of manifest.fixtures) {
  test(`fixture ${entry.file} matches its declared expectation`, () => {
    const result = validatePackage(load(entry.file));
    assert.equal(result.schemaOk, entry.schemaOk, `${entry.file}: structural verdict disagree`);
    assert.deepEqual(
      result.semantic.map((e) => e.code).sort(),
      [...entry.semantic].sort(),
      `${entry.file}: semantic codes disagree`,
    );
    for (const code of entry.schemaCodes || []) {
      assert.ok(
        result.errors.some((e) => e.source === "schema" && e.code === code),
        `${entry.file}: declared structural code ${code} not reported`,
      );
    }
    if (entry.warnings !== null) {
      assert.deepEqual(
        result.warnings.map((w) => w.code).sort(),
        [...entry.warnings].sort(),
        `${entry.file}: warnings disagree`,
      );
    }
    assert.equal(result.valid, entry.schemaOk && entry.semantic.length === 0, `${entry.file}: valid flag disagrees`);
  });
}

test("every declared semantic code is exercised by at least one fixture", () => {
  const covered = new Set(manifest.fixtures.flatMap((f) => f.semantic));
  const missing = SEMANTIC_CODES.filter((code) => !covered.has(code));
  assert.deepEqual(missing, [], `rules with no fixture: ${missing.join(", ")}`);
});

test("the SPEC 6.3 example validates once placeholders are filled", () => {
  const doc = load("valid/spec-6.3-example.json");
  const result = validatePackage(doc);
  assert.deepEqual(result.errors, []);
  assert.equal(doc.duration.mode, "target");
  assert.equal(doc.assets.a_plate1.model_license.id, "LTX-2.x-Community");
  assert.equal(doc.assets.a_plate1.license.id, "CC0-1.0");
  assert.equal(doc.assets.a_hero.origin, "stock");
});

for (const layout of Object.keys(LAYOUTS)) {
  test(`the ${layout} layout appears in a valid fixture`, () => {
    const used = manifest.fixtures
      .filter((f) => f.kind === "valid")
      .some((f) => (load(f.file).scenes || []).some((s) => s.layout === layout));
    assert.ok(used, `no valid fixture uses the ${layout} layout`);
  });
}
