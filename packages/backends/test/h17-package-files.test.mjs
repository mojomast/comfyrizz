// H17/GPU test 6: a package's own files have to reach the run workspace.
//
// The presenter made this visible: it is the first job whose input is an uploaded file (the narration)
// rather than an output of an earlier job, and the runner resolves a fileInput against the jobs.json
// folder. Nothing staged it, so the job failed with input_file_missing after the session had started.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { stagePackageFiles } from "../src/run-package.mjs";
import { silentWav } from "../../../scripts/gpu6/g6_package.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "..", "..", "pipeline-py", "tests", "fixtures", "package-gpu1-workflows.json");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-h17-files-"));
  const packageDir = join(dir, "package");
  const workDir = join(dir, "work");
  mkdirSync(join(packageDir, "audio"), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  return { dir, packageDir, workDir };
}

test("an uploaded narration is copied to where the runner looks for it (H17)", () => {
  const { packageDir, workDir } = scratch();
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  writeFileSync(join(packageDir, "audio", "s1.wav"), silentWav(0.25));

  const staged = stagePackageFiles(pkg, { workDir, packageDir });
  assert.deepEqual(staged.missing, [], JSON.stringify(staged));
  const landed = join(workDir, "audio", "s1.wav");
  assert.ok(existsSync(landed), "the file has to be beside jobs.json, not only named in the package");
  assert.equal(readFileSync(landed).subarray(0, 4).toString(), "RIFF");
  assert.ok(staged.copied.some((entry) => entry.asset === "a_narr"));
});

test("a generated asset is not expected on disk (H17)", () => {
  const { packageDir, workDir } = scratch();
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  // a_presenter is generated: it is produced by a job, so staging must not demand it exist beforehand
  const staged = stagePackageFiles(pkg, { workDir, packageDir });
  assert.equal(staged.missing.some((entry) => entry.asset === "a_presenter"), false, JSON.stringify(staged.missing));
});

test("a file the package names but does not have is reported, not skipped (H17)", () => {
  const { packageDir, workDir } = scratch();
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const staged = stagePackageFiles(pkg, { workDir, packageDir });
  assert.deepEqual(staged.missing, [{ asset: "a_narr", file: "audio/s1.wav" }]);
  assert.equal(existsSync(join(workDir, "audio", "s1.wav")), false);
});

test("staging is idempotent, so a second run does not need the source again (H17)", () => {
  const { packageDir, workDir } = scratch();
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  writeFileSync(join(packageDir, "audio", "s1.wav"), silentWav(0.25));
  stagePackageFiles(pkg, { workDir, packageDir });
  const again = stagePackageFiles(pkg, { workDir, packageDir: null });
  assert.deepEqual(again.missing, [], JSON.stringify(again));
  chmodSync(join(workDir, "audio", "s1.wav"), 0o644);
});
