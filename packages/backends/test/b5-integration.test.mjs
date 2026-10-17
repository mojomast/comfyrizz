// B5: B-side integration, end to end on CPU.
//
// package (a read-only copy of examples/launch-demo plus pending generated assets)
//   -> packages/jobs planJobs          (FLUX stills batched before LTX plates)
//   -> pipeline-py runner              (the real one, spawned as a process)
//   -> packages/backends BYO backend    (local comfy-api-proxy in front of a fake Comfy v2)
//   -> collected outputs + a manifest that decides success
//   -> outputs written back into the package with provenance that still validates.
//
// Then one injected job failure, asserting retry/partial-result behaviour: earlier outputs are
// kept, dependents are skipped, and only the failed job is resubmitted afterwards.
//
// One command: node --test test/b5-integration.test.mjs (also part of `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createByoBackend } from "../src/byo-backend.mjs";
import { applyManifestToPackage, checkJobsDoc, planJobs } from "../../jobs/src/index.mjs";
import { validatePackage } from "../../schema/src/index.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const PYTHON = join(REPO, ".venv", "bin", "python");
const FAKE_SERVER = join(REPO, "pipeline-py", "tests", "fake_comfy_server.py");
const LAUNCH_DEMO = join(REPO, "examples", "launch-demo", "package.json");
const WORKFLOW_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LTX_SHA = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

const children = [];
test.after(() => {
  for (const child of children) child.kill("SIGKILL");
});

function startFake({ port = 0, failLabels = null, requestLog = null } = {}) {
  const args = [FAKE_SERVER, "--port", String(port)];
  if (failLabels) args.push("--fail-labels", failLabels);
  if (requestLog) args.push("--request-log", requestLog);
  const child = spawn(PYTHON, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`fake Comfy v2 did not start: ${buffer}`)), 10000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = /listening on (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        const resolvedPort = Number(match[1]);
        resolvePromise({
          child,
          port: resolvedPort,
          url: `http://127.0.0.1:${resolvedPort}`,
          requestLog,
          posts: () => readRequests(requestLog).filter((entry) => entry.method === "POST" && entry.path === "/api/v2/jobs"),
        });
      }
    });
    child.on("error", reject);
  });
}

function readRequests(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** A read-only copy of the bundled example plus the pending generated assets B5 is about. */
function buildFixture(dir) {
  const pkg = JSON.parse(readFileSync(LAUNCH_DEMO, "utf8"));
  pkg.id = "pkg_b5integration01";
  pkg.assets.a_b5_still = {
    kind: "image",
    origin: "generated",
    status: "pending",
    gen: {
      generator: "flux3-klein",
      workflow: "workflows/flux3_klein_t2i.api.json",
      workflow_sha256: WORKFLOW_SHA,
      model: "flux-3-image-klein",
      caption: "A wide abstract nebula with violet filaments and empty dark space at the top left.",
      inputs: { prompt: "A wide abstract nebula, violet filaments, empty dark space top left.", width: 960, height: 544, seed: 42, steps: 16 },
    },
    model_license: { id: "FLUX.3-Image-Klein" },
  };
  pkg.assets.a_b5_plate = {
    kind: "video",
    origin: "generated",
    status: "pending",
    gen: {
      generator: "ltx25",
      workflow: "workflows/ltx25_i2v_2stage.api.json",
      workflow_sha256: LTX_SHA,
      model: "ltx-2.5-22b-distilled",
      inputs: { prompt: "slow drift through a soft blue nebula", image: "a_b5_still", width: 960, height: 544, frames: 100, fps: 24, seed: 42, stage2_seed: 43 },
    },
    model_license: { id: "LTX-2.x-Community", commercial_ok_if: "revenue<10M" },
  };
  pkg.assets.a_b5_plate2 = {
    kind: "video",
    origin: "generated",
    status: "pending",
    gen: {
      generator: "ltx25",
      workflow: "workflows/ltx25_t2v_2stage.api.json",
      workflow_sha256: LTX_SHA,
      model: "ltx-2.5-22b-distilled",
      inputs: { prompt: "endless violet fog, no camera move", width: 960, height: 544, frames: 97, fps: 24, seed: 7 },
    },
    model_license: { id: "LTX-2.x-Community" },
  };
  pkg.scenes = [
    ...pkg.scenes,
    {
      id: "s_generated",
      layout: "hero",
      variant: "full-bleed",
      preferredFrames: 240,
      copy: { headline: "Generated plates", sub: "A still, then two plates from it" },
      background: { asset: "a_b5_plate", fit: "cover", loop: true },
      foreground: [{ asset: "a_b5_still", x: 0.7, y: 0.5, w: 0.28, anim: "fade-in" }],
      transitionOut: { type: "fade", frames: 15 },
    },
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return pkg;
}

function planWithPackage(pkg, dir) {
  // the planner is the same code the CLI uses; planning in-process keeps the test to one command
  const jobsDoc = planJobs(pkg);
  assert.deepEqual(checkJobsDoc(jobsDoc), []);
  writeFileSync(join(dir, "jobs.json"), JSON.stringify(jobsDoc, null, 2));
  return jobsDoc;
}

function backendFor({ workspace, jobsDoc, fake, comfyuiUrl, runnerOut }) {
  return createByoBackend({
    comfyuiUrl,
    proxyCommand: (port) => [PYTHON, FAKE_SERVER, "--port", String(port)],
    pythonBin: PYTHON,
    outDir: runnerOut,
    jobsFile: join(workspace, "jobs.json"),
    requiredNodes: ["KSampler"],
    healthTimeoutMs: 8000,
    jobsDoc,
    fake,
  });
}

test("package -> jobs.json -> pipeline-py -> BYO backend -> package with provenance", async (t) => {
  if (!existsSync(PYTHON)) {
    t.skip(`no venv python at ${PYTHON}`);
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "comfyrizz-b5-"));
  const outDir = join(workspace, "out");
  mkdirSync(outDir, { recursive: true });
  const pkg = buildFixture(workspace);

  // 1. the fixture is a valid package, and planning it needs no network
  assert.deepEqual(validatePackage(pkg).errors, []);
  const jobsDoc = planWithPackage(pkg, workspace);
  assert.deepEqual(jobsDoc.batches.map((batch) => batch.name), ["stills", "plates"]);
  assert.deepEqual(jobsDoc.jobs.map((job) => job.id), ["a_b5_still.still", "a_b5_plate.plate", "a_b5_plate2.plate"]);

  // 2. the fake Comfy v2 stands in for ComfyUI and for the local proxy
  const requestLog = join(workspace, "requests.jsonl");
  const comfyui = await startFake();
  const proxy = await startFake({ requestLog });
  const backend = backendFor({ workspace, jobsDoc, fake: proxy, comfyuiUrl: comfyui.url, runnerOut: outDir });

  const up = await backend.ensureUp({});
  assert.equal(up.state, "started");
  const health = await backend.health();
  assert.equal(health.ok, true, health.detail);

  // 3. the real runner executes the plan against the v2 surface
  const events = [];
  const run = await backend.run(join(workspace, "jobs.json"), (event) => events.push(event));
  assert.equal(run.manifest.complete, true, JSON.stringify(run.manifest?.counts));
  assert.deepEqual(run.manifest.counts, { succeeded: 3 });

  const collected = await backend.collect(run.manifest, join(workspace, "collected"));
  assert.deepEqual(collected.problems, []);

  // every job was submitted exactly once, stills before plates
  const posts = proxy.posts();
  assert.deepEqual(posts.map((entry) => entry.label), ["a_b5_still.still", "a_b5_plate.plate", "a_b5_plate2.plate"]);
  assert.equal(posts.length, 3);

  // outputs exist on disk with the hashes the manifest recorded
  for (const entry of run.manifest.jobs) {
    const output = entry.outputs[0];
    const file = join(outDir, output.relative);
    assert.ok(existsSync(file), `${entry.job}: ${output.relative} missing`);
    assert.equal(readFileSync(file).length, output.bytes);
    assert.match(output.sha256, /^[a-f0-9]{64}$/);
  }

  // 4. progress is the runner's own JSON-lines, in the planned order
  const progress = readFileSync(join(outDir, "progress.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const submitted = progress.filter((event) => event.event === "submitted").map((event) => event.job);
  assert.deepEqual(submitted, ["a_b5_still.still", "a_b5_plate.plate", "a_b5_plate2.plate"]);
  assert.ok(progress.some((event) => event.event === "job_done"));

  // 5. outputs go back into the package with provenance that still validates
  const applied = applyManifestToPackage(pkg, { manifest: run.manifest, jobsDoc, outDir, backend: "byo-comfyui" });
  assert.equal(applied.applied.length, 3);
  assert.deepEqual(applied.candidates, []);
  const updated = applied.package;
  assert.equal(updated.revision, pkg.revision + 1);
  const still = updated.assets.a_b5_still;
  assert.equal(still.status, "ready");
  assert.equal(still.file, "assets/a_b5_still.png");
  assert.equal(still.license.id, "CC0-1.0");
  assert.equal(still.redistributable, true);
  assert.equal(still.gen.generator, "flux3-klein");
  assert.equal(still.gen.backend, "byo-comfyui");
  assert.ok(still.gen.job_id && still.gen.attempt_id);
  assert.deepEqual({ width: still.media.width, height: still.media.height }, { width: 960, height: 544 });

  const plate = updated.assets.a_b5_plate;
  assert.equal(plate.status, "ready");
  assert.equal(plate.media.frames, 97, "100 requested frames resolve to 97 (8n+1)");
  assert.equal(plate.media.audio, "muted");
  assert.equal(plate.media.width, 960);
  assert.equal(plate.cutout, undefined);

  const validation = validatePackage(updated);
  assert.deepEqual(validation.errors, [], JSON.stringify(validation.errors));
  assert.equal(validation.valid, true);
  assert.ok(updated.compliance.backends_used.includes("byo-comfyui"));

  // 6. an unchanged job is served from cache: a second run submits nothing
  const second = await backend.run(join(workspace, "jobs.json"), () => {});
  assert.equal(proxy.posts().length, 3, "the cache must prevent a second submission");
  assert.deepEqual(second.manifest.counts, { cached: 3 });

  const teardown = await backend.teardown("done");
  assert.equal(teardown.state, "stopped");
});

test("one injected job failure: partial results kept, dependents skipped, only that job retried", async (t) => {
  if (!existsSync(PYTHON)) {
    t.skip(`no venv python at ${PYTHON}`);
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "comfyrizz-b5-fail-"));
  const outDir = join(workspace, "out");
  const pkg = buildFixture(workspace);
  const jobsDoc = planWithPackage(pkg, workspace);
  const comfyui = await startFake();

  // the plate fails on the server, the other two jobs succeed independently
  const failingLog = join(workspace, "failing.jsonl");
  const failing = await startFake({ failLabels: "a_b5_plate.plate", requestLog: failingLog });
  const backendA = backendFor({ workspace, jobsDoc, fake: failing, comfyuiUrl: comfyui.url, runnerOut: outDir });
  await backendA.ensureUp({});
  const first = await backendA.run(join(workspace, "jobs.json"), () => {});

  assert.equal(first.manifest.complete, false);
  const byJob = Object.fromEntries(first.manifest.jobs.map((entry) => [entry.job, entry]));
  assert.equal(byJob["a_b5_plate.plate"].status, "failed");
  assert.equal(byJob["a_b5_plate.plate"].error.code, "node_execution_error");
  assert.equal(byJob["a_b5_still.still"].status, "succeeded");
  assert.equal(byJob["a_b5_plate2.plate"].status, "succeeded");
  assert.equal(failing.posts().length, 3);
  assert.ok(existsSync(join(outDir, byJob["a_b5_still.still"].outputs[0].relative)), "an earlier output was discarded");
  assert.ok(existsSync(join(outDir, byJob["a_b5_plate2.plate"].outputs[0].relative)));

  // partial results are applied; the failed asset stays pending, not silently ready
  const partial = applyManifestToPackage(pkg, { manifest: first.manifest, jobsDoc, outDir, backend: "byo-comfyui" });
  assert.equal(partial.applied.length, 2);
  assert.equal(partial.package.assets.a_b5_plate.status, "failed");
  assert.equal(partial.untouched.some((entry) => entry.job === "a_b5_plate.plate"), true);
  assert.deepEqual(validatePackage(partial.package).errors, []);

  // a healthy server sees only the retry: the two good jobs come back from cache
  const retryLog = join(workspace, "retry.jsonl");
  const healthy = await startFake({ requestLog: retryLog });
  const backendB = backendFor({ workspace, jobsDoc, fake: healthy, comfyuiUrl: comfyui.url, runnerOut: outDir });
  await backendB.ensureUp({});
  const second = await backendB.run(join(workspace, "jobs.json"), () => {});

  assert.equal(second.manifest.complete, true, JSON.stringify(second.manifest.counts));
  assert.deepEqual(second.manifest.counts, { succeeded: 1, cached: 2 });
  assert.deepEqual(healthy.posts().map((entry) => entry.label), ["a_b5_plate.plate"], "only the failed job was resubmitted");
  const retried = second.manifest.jobs.find((entry) => entry.job === "a_b5_plate.plate");
  assert.equal(retried.status, "succeeded");

  // the second attempt for one job, and only that job, is recorded
  const attempts = readdirSync(join(outDir, "attempts")).map((name) => JSON.parse(readFileSync(join(outDir, "attempts", name), "utf8")));
  const plateAttempts = attempts.filter((attempt) => attempt.job === "a_b5_plate.plate");
  assert.equal(plateAttempts.length, 2);
  assert.deepEqual(plateAttempts.map((attempt) => attempt.state), ["failed", "succeeded"]);
  assert.deepEqual(plateAttempts.map((attempt) => attempt.seq), [1, 2]);
  assert.equal(attempts.filter((attempt) => attempt.job === "a_b5_still.still").length, 1);
});
