// H8: one `runPackage` for both backends - the orchestration contract, with a stub backend.
//
// The point of H8 is that nothing above the backend branches on the provider: plan -> estimate -> up
// -> health -> run -> apply -> teardown, and the result says what happened at each step. This file
// pins that contract against a recording stub (instant, no processes); b5-integration.test.mjs runs
// the same call against the real BYO backend with the real runner and a fake Comfy v2, and
// colab-backend.test.mjs runs the Colab backend's own steps the same way.
//
// One command: node --test test/h8-runpackage.test.mjs (also part of `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { TEARDOWN_MODES, runPackage, withRunPackage } from "../src/run-package.mjs";
import { validatePackage } from "../../schema/src/index.mjs";

const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LAUNCH_DEMO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "examples", "launch-demo", "package.json");

/** A read-only copy of the bundled example plus one pending generated asset (as b5 does). */
function fixture() {
  const pkg = JSON.parse(readFileSync(LAUNCH_DEMO, "utf8"));
  pkg.id = "pkg_h8stub000001";
  pkg.assets.a_h8_still = {
    kind: "image",
    origin: "generated",
    status: "pending",
    gen: {
      generator: "flux3-klein",
      workflow: "workflows/flux3_klein_t2i.api.json",
      workflow_sha256: SHA,
      model: "flux-3-image-klein",
      caption: "A wide abstract nebula with violet filaments and empty dark space at the top left.",
      inputs: { prompt: "A wide abstract nebula, violet filaments, empty dark space top left.", width: 960, height: 544, seed: 42, steps: 16 },
    },
    model_license: { id: "LicenseRef-FLUX.3-Image-Klein" },
  };
  return pkg;
}

/** A backend that records everything runPackage asks it to do and answers like a healthy one. */
function stubBackend({ healthOk = true, failRun = null, failTeardown = false } = {}) {
  const calls = [];
  const backend = {
    id: "byo-comfyui",
    calls,
    async describe() {
      calls.push("describe");
      return { label: "Your own ComfyUI", costVisibility: "free (your hardware)" };
    },
    async estimate(jobs) {
      calls.push(`estimate:${jobs.length}`);
      return { gpuMinutes: 0.15, overheadMinutes: 0, units: null, basis: "measured" };
    },
    async ensureUp(opts) {
      calls.push(`ensureUp:${JSON.stringify(opts.budget ?? null)}:${opts.approved === true}`);
      return { state: "started", evidence: "stub" };
    },
    async health() {
      calls.push("health");
      return healthOk ? { ok: true, detail: "stub is up" } : { ok: false, detail: "stub says no" };
    },
    async run(jobsFile, onEvent) {
      calls.push(`run:${existsSync(jobsFile)}`);
      const jobsDoc = JSON.parse(readFileSync(jobsFile, "utf8"));
      onEvent({ v: 1, event: "job_done", job: jobsDoc.jobs[0].id });
      if (failRun) throw new Error(failRun);
      const outputs = jobsDoc.jobs.map((job) => ({
        job: job.id,
        status: "succeeded",
        job_id: "stub-job-1",
        attempt_id: "stub-attempt-1",
        outputs: [{ file: join(jobsDoc.__outDir ?? "", job.output), relative: job.output, sha256: "a".repeat(64), bytes: 1024 }],
      }));
      return {
        runId: "stub-run",
        manifest: { v: 1, complete: true, counts: { succeeded: jobsDoc.jobs.length }, jobs: outputs, updatedAt: "2026-10-17T20:00:00Z" },
      };
    },
    async teardown(reason) {
      calls.push(`teardown:${reason}`);
      if (failTeardown) throw new Error("stub refused to stop");
      return { state: "stopped", evidence: `stub stopped for ${reason}` };
    },
  };
  return backend;
}

function workdir() {
  return mkdtempSync(join(tmpdir(), "comfyrizz-h8-"));
}

test("runPackage takes a package through every step and returns the run record", async () => {
  const work = workdir();
  const backend = stubBackend();
  const events = [];
  const result = await runPackage(backend, fixture(), { workDir: work, onEvent: (e) => events.push(e) });

  assert.deepEqual(backend.calls, [
    "describe",
    "estimate:1",
    "ensureUp:null:false",
    "health",
    `run:true`,
    "teardown:done",
  ]);
  assert.equal(result.backend.id, "byo-comfyui");
  assert.equal(result.backend.label, "Your own ComfyUI");
  assert.equal(result.backend.costVisibility, "free (your hardware)");
  assert.equal(result.jobsFile, join(work, "jobs.json"));
  assert.ok(existsSync(result.jobsFile), "jobs.json is written where the backend uploads from");
  assert.deepEqual(result.jobsDoc.jobs.map((job) => job.id), ["a_h8_still.still"]);
  assert.deepEqual(result.estimate, { gpuMinutes: 0.15, overheadMinutes: 0, units: null, basis: "measured" });
  assert.equal(result.up.state, "started");
  assert.deepEqual(result.health, { ok: true, detail: "stub is up" });
  assert.deepEqual(result.counts, { succeeded: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.complete, true);
  assert.equal(result.teardown.state, "stopped");
  assert.equal(result.dryRun, false);

  // apply is on by default: the manifest is written back and the package still validates
  assert.equal(result.applied.length, 1);
  assert.equal(result.package.assets.a_h8_still.status, "ready");
  assert.equal(result.package.assets.a_h8_still.gen.job_id, "stub-job-1");
  assert.deepEqual(validatePackage(result.package).errors, []);

  // the caller sees both the runner's own events and the phases, in order
  // R1 added the quality gate between applying the manifest and leaving: the run record carries its
  // verdict, and it is a phase like any other so the panel can show it
  assert.deepEqual(events.map((e) => e.phase ?? e.event), ["planned", "up", "job_done", "ran", "applied", "gated", "teardown"]);
  assert.equal(typeof result.gate?.ran, "boolean");
  assert.equal(events.find((e) => e.phase === "planned").jobs, 1);
});

test("a dry run plans and estimates, and starts nothing", async () => {
  const backend = stubBackend();
  const result = await runPackage(backend, fixture(), { workDir: workdir(), dryRun: true });
  assert.deepEqual(backend.calls, ["describe", "estimate:1"]);
  assert.equal(result.dryRun, true);
  assert.equal(result.up, null);
  assert.equal(result.manifest, null);
  assert.equal(result.package, null);
  assert.equal(result.ok, false);
  assert.equal(result.jobsDoc.jobs.length, 1, "the plan is still there to show");
});

test("an invalid package is refused before anything is started or billed", async () => {
  const backend = stubBackend();
  const pkg = fixture();
  pkg.assets.a_h8_still.gen.workflow = "/absolute/path/workflow.json";
  await assert.rejects(() => runPackage(backend, pkg, { workDir: workdir() }), /the package is not valid/);
  assert.deepEqual(backend.calls, [], "not even describe ran");
});

test("an unhealthy backend is not submitted to, and the box is still accounted for", async () => {
  const backend = stubBackend({ healthOk: false });
  await assert.rejects(() => runPackage(backend, fixture(), { workDir: workdir() }), /not healthy: stub says no/);
  assert.deepEqual(backend.calls, ["describe", "estimate:1", "ensureUp:null:false", "health", "teardown:error"]);
});

test("a run that throws stops the box and rethrows with the record attached", async () => {
  const backend = stubBackend({ failRun: "the runner died" });
  await assert.rejects(
    () => runPackage(backend, fixture(), { workDir: workdir() }),
    (error) => {
      assert.match(error.message, /the runner died/);
      assert.equal(error.runPackage.teardown.state, "stopped");
      assert.equal(error.runPackage.up.state, "started");
      return true;
    },
  );
  assert.deepEqual(backend.calls.slice(-1), ["teardown:error"]);
});

test("a teardown that itself fails is reported, not thrown away", async () => {
  const backend = stubBackend({ failRun: "boom", failTeardown: true });
  await assert.rejects(() => runPackage(backend, fixture(), { workDir: workdir() }), (error) => {
    assert.equal(error.runPackage.teardown.state, "unknown");
    assert.match(error.runPackage.teardown.evidence, /teardown also failed/);
    return true;
  });
});

test("teardownMode says how the box is left behind", async () => {
  // done: stop it; idle: stop it but tell the backend to keep it warm for the next run; never: leave
  // it entirely alone (the caller owns it then)
  for (const [mode, reason, state] of [["done", "done", "stopped"], ["idle", "idle", "stopped"], ["never", null, null]]) {
    const backend = stubBackend();
    const result = await runPackage(backend, fixture(), { workDir: workdir(), teardownMode: mode });
    assert.deepEqual(backend.calls.filter((call) => call.startsWith("teardown")), reason ? [`teardown:${reason}`] : [], mode);
    if (state === null) {
      assert.equal(result.teardown, null, `${mode} leaves the box alone`);
    } else {
      assert.equal(result.teardown.state, state, mode);
      assert.match(result.teardown.evidence, new RegExp(reason), mode);
    }
    assert.ok(TEARDOWN_MODES.includes(mode));
  }
  await assert.rejects(() => runPackage(stubBackend(), fixture(), { workDir: workdir(), teardownMode: "later" }), /unknown teardownMode/);
});

test("withRunPackage attaches the same call to a backend", async () => {
  const backend = withRunPackage(stubBackend());
  assert.equal(typeof backend.runPackage, "function");
  const result = await backend.runPackage(fixture(), { workDir: workdir(), apply: false });
  assert.equal(result.ok, true);
  assert.equal(result.package, null, "apply: false leaves the package to the caller");
  assert.equal(result.applied.length, 0);
});

test("apply: false is the only difference: the manifest is still the record", async () => {
  const backend = stubBackend();
  const result = await runPackage(backend, fixture(), { workDir: workdir(), apply: false, teardownMode: "idle" });
  assert.equal(result.manifest.complete, true);
  assert.deepEqual(result.counts, { succeeded: 1 });
  assert.equal(result.teardown.state, "stopped");
});

test("the caller's own abort signal reaches the backend", async () => {
  const backend = stubBackend();
  const controller = new AbortController();
  const seen = [];
  backend.run = async (jobsFile, onEvent, signal) => {
    seen.push(signal === controller.signal);
    return { manifest: { complete: true, counts: { succeeded: 0 }, jobs: [] } };
  };
  const result = await runPackage(backend, fixture(), { workDir: workdir(), signal: controller.signal, apply: false });
  assert.deepEqual(seen, [true]);
  assert.equal(result.manifest.complete, true);
});

test("a manifest with a failed job is not ok, and says so", async () => {
  const backend = stubBackend();
  backend.run = async () => ({
    manifest: { complete: false, counts: { succeeded: 1, failed: 1, skipped: 1 }, jobs: [] },
  });
  const result = await runPackage(backend, fixture(), { workDir: workdir(), apply: false });
  assert.equal(result.ok, false);
  assert.deepEqual(result.counts, { succeeded: 1, failed: 1, skipped: 1 });
});

test("a package fixture that is written by hand still validates", () => {
  // a guard on this file's own fixture: if the package schema moves, the orchestration tests above
  // would fail with a refusal instead of exercising runPackage
  assert.deepEqual(validatePackage(fixture()).errors, []);
  const path = join(workdir(), "package.json");
  writeFileSync(path, JSON.stringify(fixture()));
  assert.ok(existsSync(path));
});

// H-fix7: the assets a Google Colab run produces have to carry the tag the schema accepts
// (`colab:<hardware>`), not the backend's bare id. Pi hit this in C9: `runPackage` passed "colab",
// the applied package was rejected, and the server had to normalise it afterwards.
test("a Google Colab run tags applied assets colab:<hardware>", async () => {
  const backend = stubBackend();
  backend.id = "colab";
  backend.ensureUp = async () => ({ state: "created", session: "comfyrizz-h8", hardware: "G4", evidence: "stub" });
  backend.appliedBackendId = ({ up }) => `colab:${up?.hardware ?? "G4"}`;

  const result = await runPackage(backend, fixture(), { workDir: workdir(), outDir: workdir() });

  assert.equal(result.backend.id, "colab");
  assert.equal(result.backend.appliedId, "colab:G4");
  const asset = result.package.assets.a_h8_still;
  assert.equal(asset.gen.backend, "colab:G4");
  assert.equal(asset.status, "ready");
  assert.ok(result.package.compliance.backends_used.includes("colab:G4"), JSON.stringify(result.package.compliance.backends_used));
  assert.deepEqual(validatePackage(result.package).errors, []);
});

test("a BYO run keeps byo-comfyui, and the backend that says nothing gets its plain id", async () => {
  const byo = await runPackage(stubBackend(), fixture(), { workDir: workdir(), outDir: workdir() });
  assert.equal(byo.package.assets.a_h8_still.gen.backend, "byo-comfyui");
  assert.equal(byo.backend.appliedId, "byo-comfyui");

  // no appliedBackendId method: the id itself is the tag (the pre-H-fix7 behaviour, kept for stubs)
  const silent = stubBackend();
  silent.id = "some-other-backend";
  const result = await runPackage(silent, fixture(), { workDir: workdir(), outDir: workdir() });
  assert.equal(result.backend.appliedId, "some-other-backend");
  assert.equal(result.package.assets.a_h8_still.gen.backend, "some-other-backend");
});
