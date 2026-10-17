// B1 acceptance: the TypeScript and Python implementations must agree, code for code,
// on the whole shared fixture corpus. This is the test that makes "the same semantic
// rules in both languages" a fact rather than an intention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackage, applyDefaults, loadSchema } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const repo = join(pkgDir, "..", "..");
const pipelineDir = join(repo, "pipeline-py");
const FIXTURES = join(pkgDir, "fixtures");
const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));

function findPython() {
  const candidates = [process.env.COMFYRIZZ_PYTHON, join(repo, ".venv", "bin", "python"), "python3"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "import jsonschema"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = findPython();
const strict = process.env.COMFYRIZZ_STRICT_CONFORMANCE === "1";

function pythonReport(file) {
  const run = spawnSync(python, ["-m", "comfyrizz_pipeline.validate", file, "--json"], {
    cwd: pipelineDir,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: pipelineDir },
  });
  assert.equal(run.status === 0 || run.status === 1, true, `python validator failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

test("python jsonschema validator is available for the conformance sweep", { skip: python ? false : "no python with jsonschema found (set COMFYRIZZ_PYTHON)" }, () => {
  if (strict) assert.ok(python, "COMFYRIZZ_STRICT_CONFORMANCE=1 requires a python with jsonschema");
  assert.ok(python);
});

// The two libraries word their structural findings differently (ajv reports an
// aggregate keyword and its inner failure, jsonschema reports one of them), so the
// cross-language claim is: the same verdict, the same semantic findings, and every
// structural code the fixture declares present on both sides. Semantic findings are
// compared exactly, code and path.
test("both implementations agree on every fixture", { skip: python ? false : "no python with jsonschema found" }, () => {
  const disagreements = [];
  for (const entry of manifest.fixtures) {
    const file = join(FIXTURES, entry.file);
    const ts = validatePackage(JSON.parse(readFileSync(file, "utf8")));
    const py = pythonReport(file);
    if (py.schemaOk !== ts.schemaOk) disagreements.push(`${entry.file}: schemaOk ts=${ts.schemaOk} py=${py.schemaOk}`);
    if (py.valid !== ts.valid) disagreements.push(`${entry.file}: valid ts=${ts.valid} py=${py.valid}`);
    const tsSem = JSON.stringify(ts.semantic.map((e) => `${e.code}${e.path}`).sort());
    const pySem = JSON.stringify(py.errors.filter((e) => e.source === "semantic").map((e) => `${e.code}${e.path}`).sort());
    if (tsSem !== pySem) disagreements.push(`${entry.file}: semantic ts=${tsSem} py=${pySem}`);
    for (const code of entry.schemaCodes || []) {
      const inTs = ts.errors.some((e) => e.source === "schema" && e.code === code);
      const inPy = py.errors.some((e) => e.source === "schema" && e.code === code);
      if (!inTs || !inPy) disagreements.push(`${entry.file}: declared structural code ${code} ts=${inTs} py=${inPy}`);
    }
  }
  assert.deepEqual(disagreements, [], disagreements.join("\n"));
});

test("both implementations produce the same normalised document", { skip: python ? false : "no python with jsonschema found" }, () => {
  const probe = spawnSync(
    python,
    ["-c", "import json,sys;from comfyrizz_pipeline import schema as S;print(json.dumps(S.apply_defaults(json.load(open(sys.argv[1]))),sort_keys=True))", join(FIXTURES, "valid/defaults-unfilled.json")],
    { cwd: pipelineDir, encoding: "utf8", env: { ...process.env, PYTHONPATH: pipelineDir } },
  );
  assert.equal(probe.status, 0, probe.stderr);
  const fromPython = JSON.parse(probe.stdout);
  const fromTypeScript = JSON.parse(JSON.stringify(applyDefaults(JSON.parse(readFileSync(join(FIXTURES, "valid/defaults-unfilled.json"), "utf8")), loadSchema())));
  assert.deepEqual(Object.keys(fromPython).sort(), Object.keys(fromTypeScript).sort());
  assert.deepEqual(fromPython.scenes[0], fromTypeScript.scenes[0]);
  assert.deepEqual(fromPython.assets, fromTypeScript.assets);
  assert.deepEqual(fromPython.datasets, fromTypeScript.datasets);
  assert.ok(existsSync(join(pipelineDir, "comfyrizz_pipeline", "schema.py")));
});

test("the fixture corpus itself is what both sides read", () => {
  assert.ok(manifest.fixtures.length >= 30);
  const first = manifest.fixtures[0];
  assert.ok(existsSync(join(FIXTURES, first.file)));
});
