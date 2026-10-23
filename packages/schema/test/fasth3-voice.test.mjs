import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validatePackage, schemaErrors, loadSchema, applyDefaults } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const minimal = JSON.parse(readFileSync(join(pkgDir, "fixtures", "valid", "minimal.json"), "utf8"));

function baseDoc() {
  const doc = structuredClone(minimal);
  doc.assets.a_plate = {
    kind: "video",
    origin: "generated",
    status: "ready",
    file: "assets/a_plate.mp4",
    sha256: "0".repeat(64),
    license: { id: "CC0-1.0" },
    redistributable: true,
    gen: {
      generator: "fasth3-omni",
      workflow: "workflows/fasth3_omni_ref2va.api.json",
      workflow_sha256: "0".repeat(64),
      direction: {
        subject: "s",
        composition: "c",
        action: "a",
        camera: "cam",
        soundscape: "ss",
        characterCount: 1,
      },
    },
  };
  return doc;
}

const voicePath = "/assets/a_plate/gen/direction/voice";

function setVoice(v) {
  const doc = baseDoc();
  if (v === undefined) {
    delete doc.assets.a_plate.gen.direction.voice;
  } else {
    doc.assets.a_plate.gen.direction.voice = v;
  }
  return doc;
}

function schemaErrs(doc) {
  return schemaErrors(doc);
}

function atVoice(errs) {
  return errs.some((e) => e.path === voicePath || e.path.startsWith(voicePath + "/"));
}

test("fasth3 voice: prompt with description+seed validates", () => {
  const doc = setVoice({ mode: "prompt", description: "a calm narrator", seed: 42 });
  assert.deepEqual(schemaErrs(doc), []);
});

test("fasth3 voice: clip alone validates", () => {
  const doc = setVoice({ mode: "clip" });
  assert.deepEqual(schemaErrs(doc), []);
});

test("fasth3 voice: absent validates", () => {
  const doc = setVoice(undefined);
  assert.deepEqual(schemaErrs(doc), []);
});

test("fasth3 voice: prompt without description is schema error at voice path", () => {
  const doc = setVoice({ mode: "prompt", seed: 42 });
  const errs = schemaErrs(doc);
  assert.ok(errs.length > 0);
  assert.ok(atVoice(errs), JSON.stringify(errs));
});

test("fasth3 voice: prompt without seed is schema error at voice path", () => {
  const doc = setVoice({ mode: "prompt", description: "a calm narrator" });
  const errs = schemaErrs(doc);
  assert.ok(errs.length > 0);
  assert.ok(atVoice(errs), JSON.stringify(errs));
});

test("fasth3 voice: clip with description is schema error at voice path", () => {
  const doc = setVoice({ mode: "clip", description: "a calm narrator" });
  const errs = schemaErrs(doc);
  assert.ok(errs.length > 0);
  assert.ok(atVoice(errs), JSON.stringify(errs));
});

test("fasth3 voice: unknown key is schema error at voice path", () => {
  const doc = setVoice({ mode: "clip", extra: 1 });
  const errs = schemaErrs(doc);
  assert.ok(errs.length > 0);
  assert.ok(atVoice(errs), JSON.stringify(errs));
});

test("fasth3 voice: seed -1 is schema error", () => {
  const doc = setVoice({ mode: "prompt", description: "a calm narrator", seed: -1 });
  const errs = schemaErrs(doc);
  assert.ok(errs.length > 0);
  assert.ok(atVoice(errs), JSON.stringify(errs));
});

test("fasth3 voice: seed 4294967296 is schema error", () => {
  const doc = setVoice({ mode: "prompt", description: "a calm narrator", seed: 4294967296 });
  const errs = schemaErrs(doc);
  assert.ok(errs.length > 0);
  assert.ok(atVoice(errs), JSON.stringify(errs));
});

test("fasth3 voice: seed 1.5 is schema error", () => {
  const doc = setVoice({ mode: "prompt", description: "a calm narrator", seed: 1.5 });
  const errs = schemaErrs(doc);
  assert.ok(errs.length > 0);
  assert.ok(atVoice(errs), JSON.stringify(errs));
});

test("fasth3 voice: description empty is schema error", () => {
  const doc = setVoice({ mode: "prompt", description: "", seed: 42 });
  const errs = schemaErrs(doc);
  assert.ok(errs.length > 0);
  assert.ok(atVoice(errs), JSON.stringify(errs));
});

test("fasth3 voice: description 301 chars is schema error", () => {
  const doc = setVoice({ mode: "prompt", description: "a".repeat(301), seed: 42 });
  const errs = schemaErrs(doc);
  assert.ok(errs.length > 0);
  assert.ok(atVoice(errs), JSON.stringify(errs));
});

test("fasth3 voice: applyDefaults adds no voice", () => {
  const doc = setVoice(undefined);
  const out = applyDefaults(doc, loadSchema());
  assert.equal(out.assets.a_plate.gen.direction.voice, undefined);
});

test("fasth3 voice: loadSchema shows no default", () => {
  const v = loadSchema().$defs.fastH3Direction.properties.voice;
  assert.equal(v.default, undefined);
  assert.equal(v.properties.mode.default, undefined);
  assert.equal(v.properties.description.default, undefined);
  assert.equal(v.properties.seed.default, undefined);
});

test("fasth3 voice: types.ts contains the voice type", () => {
  const types = readFileSync(join(pkgDir, "types.ts"), "utf8");
  assert.match(types, /FastH3Direction/);
  assert.match(types, /voice\?: \{/);
});
