// Exercise the real BYO runner/host boundary with a local mocked runner. No
// provider, proxy, GPU, or actual generation is used by this receipt regression.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createByoBackend } from "../src/byo-backend.mjs";
import { verifyModelContribution } from "../../jobs/src/model-contribution.mjs";
import { KLEIN_SHA, KLEIN_WORKFLOW, assertCollectedReceipt } from "./mock-generation.mjs";

function fixture(t, mode = "succeeded") {
  const root = mkdtempSync(join(tmpdir(), "comfyrizz-byo-receipts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(new URL("../../schema/fixtures/valid/minimal.json", import.meta.url)));
  pkg.assets.a_still = {
    kind: "image", origin: "generated", status: "pending",
    gen: { generator: "flux3-klein", model: "flux-3-image-klein", workflow: KLEIN_WORKFLOW,
      workflow_sha256: KLEIN_SHA, inputs: { prompt: "A calm blue sea.", width: 960, height: 544, seed: 7 } },
    model_license: { id: "LicenseRef-FLUX.3-Image-Klein" },
  };
  pkg.scenes[0].background = { asset: "a_still", fit: "cover" };
  pkg.scenes[0].transitionOut = { type: "cut", frames: 0 };
  const runner = join(root, "mock-runner.mjs");
  writeFileSync(runner, `
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { mockCapture, mockOutput } from ${JSON.stringify(new URL("./mock-generation.mjs", import.meta.url).href)};
    const arg = name => process.argv[process.argv.indexOf(name) + 1];
    const doc = JSON.parse(readFileSync(arg('--jobs')));
    const dir = arg('--out');
    const [job] = doc.jobs;
    const mode = ${JSON.stringify(mode)};
    const status = mode === 'reuse' ? (existsSync(join(dir, 'manifest.json')) ? 'cached' : 'succeeded') : mode;
    const content = 'mock BYO output, not real generated media';
    mkdirSync(dirname(join(dir, job.output)), { recursive: true });
    writeFileSync(join(dir, job.output), status === 'tampered' ? 'x'.repeat(content.length) : content);
    const capture = mockCapture(job);
    writeFileSync(join(dir, capture.relative), capture.content);
    const settled = ['succeeded', 'tampered', 'cached'].includes(status);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      v: 1, run_id: 'mock-byo-run', packageId: doc.packageId, jobsHash: doc.hash,
      complete: settled, counts: { [status === 'tampered' ? 'succeeded' : status]: 1 },
      jobs: [{ job: job.id, status: status === 'tampered' ? 'succeeded' : status,
        job_id: 'mock-byo-job', attempt_id: 'mock-byo-attempt', outputs: settled ? [mockOutput(job, content)] : [] }],
    }));
  `);
  const outputDir = join(root, "runner-output");
  mkdirSync(outputDir);
  const backend = createByoBackend({
    comfyuiUrl: "http://127.0.0.1:1", outDir: outputDir,
    runnerCommand: [process.execPath, runner], runnerCwd: root,
  });
  backend.ensureUp = async () => ({ state: "mocked" });
  backend.health = async () => ({ ok: true });
  const run = () => backend.runPackage(pkg, {
    workDir: join(root, "work"), outDir: join(root, "caller-output"), gateCommand: null,
  });
  return { pkg, outputDir, run };
}

test("BYO verifies its actual runner output directory and records bound generation receipts", async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.verification?.verified, true, "BYO must pass through host verification");
  assert.equal(result.verification.dir, f.outputDir, "the caller output directory is not the runner directory");
  assert.equal(result.ok, true);
  assertCollectedReceipt(result, "a_still");
});

test("BYO tampered, pending, failed and unproven cached output cannot qualify", async t => {
  for (const mode of ["tampered", "pending", "failed", "cached"]) {
    await t.test(mode, async t => {
      const f = fixture(t, mode);
      const result = await f.run();
      assert.equal(verifyModelContribution({ pkg: result.package, packageDir: f.outputDir }).ok, false);
      assert.deepEqual(result.generationReceipts ?? [], []);
      if (mode !== "cached") {
        assert.equal(result.ok, false);
        assert.equal(result.applied.length, 0);
        assert.notEqual(result.package.assets.a_still.status, "ready");
      }
      if (mode === "tampered") {
        assert.equal(result.verification?.verified, false);
        assert.match(result.verification.problems.join("\n"), /sha256/);
      }
    });
  }
});

test("BYO cached output reuses the original receipt without minting another", async t => {
  const f = fixture(t, "reuse");
  const first = await f.run();
  assertCollectedReceipt(first, "a_still");
  const second = await f.run();
  assert.equal(second.verification.verified, true);
  assert.equal(second.manifest.jobs[0].status, "cached");
  assert.deepEqual(second.generationReceipts, []);
  const verified = verifyModelContribution({ pkg: second.package, packageDir: f.outputDir });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.evidence[0].receipt, first.generationReceipts[0]);
  assert.equal(second.package.assets.a_still.sha256, first.package.assets.a_still.sha256);
  assert.equal(second.package.assets.a_still.gen.attempt_id, first.package.assets.a_still.gen.attempt_id);
});
