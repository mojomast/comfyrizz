// G6-7: the 10:20 real run shipped a jobs.zip with no workflows/ (g6_run passed packageDir twice, the
// second time as null), and every GPU job failed `workflow_unreadable` after the session was paid for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBundleComplete, bundleMissingInputs, createBundle } from "../src/colab-backend.mjs";

function stage({ withWorkflow = true } = {}) {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-g67-"));
  const packageDir = join(work, "workspace");
  mkdirSync(join(packageDir, "workflows"), { recursive: true });
  mkdirSync(join(packageDir, "audio"), { recursive: true });
  mkdirSync(join(packageDir, "out"), { recursive: true });
  if (withWorkflow) writeFileSync(join(packageDir, "workflows", "still.api.json"), "{}");
  writeFileSync(join(packageDir, "workflows", "a2v.api.json"), "{}");
  writeFileSync(join(packageDir, "audio", "s1.wav"), "RIFF");
  writeFileSync(join(packageDir, "package.json"), '{"id":"pkg_g67"}');
  const jobsFile = join(packageDir, "jobs.json");
  writeFileSync(
    jobsFile,
    JSON.stringify({
      v: 1,
      packageId: "pkg_g67",
      jobs: [
        { id: "a_still.still", workflow: "workflows/still.api.json" },
        {
          id: "a_presenter.presenter",
          workflow: "workflows/a2v.api.json",
          fileInputs: [
            { param: "image", from: "job", job: "a_still.still", path: "assets/a_still.png" },
            { param: "audio", from: "package", path: "audio/s1.wav" },
          ],
        },
      ],
      hash: "a".repeat(64),
    }),
  );
  return { work, packageDir, jobsFile };
}

test("G6-7: a bundle built with the real packageDir carries the workflows and package inputs at the jobs.json root", () => {
  const { work, packageDir, jobsFile } = stage();
  try {
    const bundle = createBundle({ jobsFile, packageDir, scratch: work });
    assert.deepEqual(bundleMissingInputs(bundle), []);
    assert.equal(assertBundleComplete(bundle), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("G6-7: the pre-check names a missing workflow, and a bundle with no packageDir at all", () => {
  const { work, packageDir, jobsFile } = stage({ withWorkflow: false });
  try {
    const bundle = createBundle({ jobsFile, packageDir, scratch: work });
    assert.deepEqual(bundleMissingInputs(bundle), ["a_still.still: workflows/still.api.json"]);
    assert.throws(() => assertBundleComplete(bundle), /missing 1 file\(s\).*a_still\.still: workflows\/still\.api\.json/);
    // the G6-7 shape: packageDir null ships jobs.json alone
    const bare = createBundle({ jobsFile, packageDir: null, scratch: work });
    assert.deepEqual(bundleMissingInputs(bare).sort(), [
      "a_presenter.presenter: audio/s1.wav",
      "a_presenter.presenter: workflows/a2v.api.json",
      "a_still.still: workflows/still.api.json",
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
