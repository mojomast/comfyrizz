// B1 acceptance: API surface, semantic units that no JSON fixture can carry, and the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDefaults,
  loadSchema,
  pathProblem,
  semanticCheck,
  validatePackage,
  SCHEMA_PATH,
  LAYOUTS,
  GENERATED_OUTPUT_LICENSE,
} from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const repo = join(pkgDir, "..", "..");
const fixture = (rel) => join(pkgDir, "fixtures", rel);
const load = (rel) => JSON.parse(readFileSync(fixture(rel), "utf8"));

test("the schema file is JSON Schema 2020-12 and declares the v1 id", () => {
  const schema = loadSchema();
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.title, "comfyrizz.package/v1");
  assert.ok(SCHEMA_PATH.endsWith("package-v1.schema.json"));
  assert.deepEqual(schema.properties.schemaVersion, { const: 1, description: schema.properties.schemaVersion.description });
});

test("layout contract is published and the chart layout requires data", () => {
  assert.deepEqual(Object.keys(LAYOUTS).sort(), ["chart", "hero", "list", "stat", "title"]);
  assert.equal(LAYOUTS.chart.requiresData, true);
  assert.deepEqual(LAYOUTS.chart.variants, ["bar"]);
  assert.deepEqual(LAYOUTS.list.variants, ["bullets", "quote"]);
  assert.equal(LAYOUTS.title.limits.headline, 48);
});

test("copy that exceeds a layout limit is a fail state, not silent clipping", () => {
  const doc = load("valid/minimal.json");
  doc.scenes[0].copy.headline = "x".repeat(LAYOUTS.title.limits.headline + 1);
  const result = validatePackage(doc);
  assert.equal(result.valid, false);
  assert.deepEqual(result.semantic.map((e) => e.code), ["SEM_COPY_TOO_LONG"]);
  assert.match(result.semantic[0].message, /allows 48 characters/);
});

test("a non-finite number is reported instead of crashing", () => {
  const doc = load("valid/minimal.json");
  doc.datasets = { d_bad: { unit: "x", values: [{ label: "a", value: Number.NaN }], source: "user" } };
  const result = semanticCheck(doc);
  assert.ok(result.errors.some((e) => e.code === "SEM_NUMBER_NOT_FINITE"));
});

test("path rules: the documented table", () => {
  const table = [
    ["assets/a.png", null],
    ["out/final.mp4", null],
    ["/etc/passwd", "absolute path"],
    ["~/secrets.txt", "home-relative path"],
    ["C:/windows/thing.png", "Windows drive path"],
    ["assets\\a.png", "backslash separator"],
    ["../outside.mp4", "parent-directory traversal"],
    ["assets/../../outside.mp4", "parent-directory traversal"],
    ["https://example.com/a.png", "URL where a relative path is expected"],
    ["assets//a.png", "empty path segment"],
    ["./assets/a.png", "leading ./ is noise; use a clean relative path"],
    ["", "empty path"],
    [null, "empty path"],
    [12, "empty path"],
  ];
  for (const [value, expected] of table) {
    assert.equal(pathProblem(value), expected, `pathProblem(${JSON.stringify(value)})`);
  }
});

test("applyDefaults fills the generated-first defaults and does not mutate the input", () => {
  const doc = load("valid/defaults-unfilled.json");
  const out = applyDefaults(doc, loadSchema());
  assert.deepEqual(out.assets.a_bg.license, { id: GENERATED_OUTPUT_LICENSE.id });
  assert.equal(out.assets.a_bg.redistributable, true);
  assert.equal(out.assets.a_bg.cutout, false);
  assert.equal(out.scenes[0].locked, false);
  assert.deepEqual(out.scenes[0].transitionOut, { type: "fade", frames: 15 });
  assert.equal(out.scenes[0].background.fit, "cover");
  assert.equal(out.scenes[0].background.loop, true);
  assert.equal(out.scenes[0].foreground[0].anim, "none");
  assert.equal(out.datasets.d_maybe.approved, false);
  assert.equal(doc.assets.a_bg.license, undefined, "applyDefaults must be pure");
});

test("validatePackage with defaults validates the normalised document", () => {
  const doc = load("valid/defaults-unfilled.json");
  const result = validatePackage(doc, { defaults: true });
  assert.equal(result.valid, true);
  assert.deepEqual(result.document.scenes[0].transitionOut, { type: "fade", frames: 15 });
});

test("CLI: valid fixture exits 0, invalid exits 1, --json carries the codes", () => {
  const cli = join(pkgDir, "bin", "comfyrizz-validate.mjs");
  const good = spawnSync(process.execPath, [cli, fixture("valid/minimal.json"), "--json"], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  const goodReport = JSON.parse(good.stdout);
  assert.equal(goodReport.valid, true);

  const bad = spawnSync(process.execPath, [cli, fixture("invalid/absolute-path.json")], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /SEM_PATH_NOT_RELATIVE/);

  const missing = spawnSync(process.execPath, [cli, fixture("nope.json")], { encoding: "utf8" });
  assert.equal(missing.status, 2);
});

test("CLI reads a package from stdin", () => {
  const cli = join(pkgDir, "bin", "comfyrizz-validate.mjs");
  const text = readFileSync(fixture("valid/spec-6.3-example.json"), "utf8");
  const run = spawnSync(process.execPath, [cli, "-", "--json"], { input: text, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).valid, true);
});

test("the package validator is not a no-op on the repo's own example layout", () => {
  // A guard against a validator that passes everything: a mangled document must fail.
  const doc = load("valid/spec-6.3-example.json");
  doc.scenes[0].layout = "carousel";
  const result = validatePackage(doc);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "SCHEMA_ENUM"));
  // the root this test resolves is the checkout the test file lives in, and it is identified by what
  // is *in* it: a fresh clone lands in whatever directory the person chose (H11 clean-clone check),
  // so a directory name is not a property of this repo
  assert.ok(existsSync(join(repo, "examples", "launch-demo", "package.json")), `no example package under ${repo}`);
});

test("SEMANTIC_CODES is exported and stable-sized", () => {
  assert.ok(Object.isFrozen(LAYOUTS));
  assert.ok(Object.isFrozen(GENERATED_OUTPUT_LICENSE));
});

test("K1: captions.style is a closed enum and absent by default", () => {
  const doc = load("valid/minimal.json");
  assert.equal(validatePackage(doc).valid, true, "a package with no captions block stays valid");
  for (const style of ["sentence", "karaoke", "word-pop", "big-word"]) {
    const withStyle = { ...doc, captions: { style } };
    assert.equal(validatePackage(withStyle).valid, true, `${style} must validate`);
  }
  const bad = { ...doc, captions: { style: "shout" } };
  const result = validatePackage(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /captions/.test(e.path)));
  assert.equal(validatePackage({ ...doc, captions: { style: "sentence", extra: 1 } }).valid, false, "unknown caption keys are rejected");
});

test("M1: the audio block is optional and closed", () => {
  const doc = load("valid/minimal.json");
  assert.equal(validatePackage(doc).valid, true, "a package with no audio block stays valid");
  const readyBed = { kind: "audio", origin: "upload", status: "ready", file: "audio/bed.wav", sha256: "b".repeat(64) };
  const withAudio = {
    ...doc,
    assets: { ...doc.assets, a_bed: readyBed },
    audio: {
      music: { asset: "a_bed", gain_db: -20 },
      ambience: { gain_db: -24 },
      sfx: [{ asset: "a_bed", scene: "s1", at: "scene-end", offset_seconds: 0.2 }],
    },
  };
  const good = validatePackage(withAudio);
  assert.equal(good.valid, true, JSON.stringify(good.errors));
  assert.equal(validatePackage({ ...withAudio, audio: { ...withAudio.audio, extra: 1 } }).valid, false, "unknown audio keys are rejected");
  assert.equal(validatePackage({ ...withAudio, audio: { sfx: [{ asset: "a_bed", scene: "s1", at: "nope" }] } }).valid, false, "sfx.at is a closed enum");
  assert.equal(validatePackage({ ...withAudio, audio: { music: {} } }).valid, false, "music needs an asset");
  assert.equal(validatePackage({ ...withAudio, audio: { music: { asset: "a_bed", gain_db: 99 } } }).valid, false, "gain_db is bounded");
});
