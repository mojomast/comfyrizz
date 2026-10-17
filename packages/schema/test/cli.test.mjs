// H-fix3 (GPU test 2, issue 7): the validator CLI has to know a plan from a package.
//
// `jobs.json` used to come back as "must have required property scenes", which reads as a broken
// plan when the document is simply not a package. These tests pin the three cases: an auto-detected
// plan, a plan forced with --jobs, and a broken plan that is actually broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planJobs } from "../../jobs/src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "bin", "comfyrizz-validate.mjs");
const JOBS_FIXTURE = join(here, "..", "..", "..", "pipeline-py", "tests", "fixtures", "jobs.json");
const PACKAGE_FIXTURE = join(here, "..", "fixtures", "valid", "spec-6.3-example.json");

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const report = (...args) => JSON.parse(run("--json", ...args).stdout);

test("a jobs.json is recognised as a plan, not reported as a broken package", () => {
  const result = run(JOBS_FIXTURE);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /VALID {2}.*jobs\.json \(jobs\)/);

  const parsed = report(JOBS_FIXTURE);
  assert.equal(parsed.kind, "jobs");
  assert.equal(parsed.detected, true, "the CLI worked out what the document was");
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.errors, []);
});

test("--jobs and --package force the mode in both directions", () => {
  const forced = report("--jobs", JOBS_FIXTURE);
  assert.equal(forced.kind, "jobs");
  assert.equal(forced.detected, false, "forced, not detected");

  const asPackage = report("--package", JOBS_FIXTURE);
  assert.equal(asPackage.kind, "package");
  assert.equal(asPackage.valid, false);
  assert.ok(asPackage.errors.some((error) => /scenes/.test(error.message)), JSON.stringify(asPackage.errors));

  assert.equal(run("--jobs", "--package", JOBS_FIXTURE).status, 2, "the two modes cannot both apply");
});

test("a package is still validated as a package", () => {
  const parsed = report(PACKAGE_FIXTURE);
  assert.equal(parsed.kind, "package");
  assert.equal(parsed.valid, true, JSON.stringify(parsed.errors));
});

test("a broken plan is named as broken, with the same gate the runner applies", () => {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-cli-jobs-"));
  const doc = JSON.parse(readFileSync(JOBS_FIXTURE, "utf8"));
  doc.jobs[0].output = "/etc/passwd";
  doc.jobs[1].cacheKey = "nope";
  doc.jobs[2].deps = ["a_dependency_that_does_not_exist"];
  const broken = join(dir, "jobs.json");
  writeFileSync(broken, JSON.stringify(doc, null, 2));

  const result = run(broken);
  assert.equal(result.status, 1, result.stdout);
  const parsed = report(broken);
  assert.equal(parsed.kind, "jobs");
  assert.equal(parsed.valid, false);
  assert.ok(parsed.errors.some((error) => /cacheKey/.test(error.message)), JSON.stringify(parsed.errors));
  assert.ok(parsed.errors.some((error) => /dependency a_dependency_that_does_not_exist/.test(error.message)), JSON.stringify(parsed.errors));
  assert.ok(parsed.errors.some((error) => error.code === "JOBS_PATTERN" || error.code === "JOBS_SEMANTIC"), JSON.stringify(parsed.errors));
});

test("a freshly planned document passes the CLI", () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "..", "jobs", "test", "fixtures", "package-pending.json"), "utf8"));
  const doc = planJobs(pkg);
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-cli-plan-"));
  const path = join(dir, "jobs.json");
  writeFileSync(path, JSON.stringify(doc, null, 2));
  const result = run(path);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
