// IP09: per-production scratch, and collect / verify / apply as separate retryable steps.
//
// The failure these tests exist for is a paid one: a Google Colab run collects into its own scratch
// directory, while the pipeline worker passes an unrelated outDir. Verifying the wrong directory makes
// every output look missing and re-downloads the whole tree while the GPU is still billing. These
// tests drive the REAL Google Colab backend through the same layout the worker uses, with a fake
// `colab` executable; nothing here talks to Google Colab or the network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createColabBackend,
  productionScratchDir,
  verifyAgainstManifest,
} from "../src/colab-backend.mjs";
import { planJobs } from "../../jobs/src/index.mjs";
import { installFakeColab, makeCli, readLog } from "./helpers.mjs";
import { runPackage } from "../src/run-package.mjs";
import { KLEIN_SHA, mockCapture, mockOutput, assertCollectedReceipt } from "./mock-generation.mjs";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const LAUNCH_DEMO = join(REPO, "examples", "launch-demo", "package.json");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A valid package with one pending generated still per requested id. */
function fixture(...assetIds) {
  const pkg = JSON.parse(readFileSync(LAUNCH_DEMO, "utf8"));
  pkg.id = "pkg_ip09collect";
  for (const [index, assetId] of assetIds.entries()) {
    pkg.assets[assetId] = {
      kind: "image",
      origin: "generated",
      status: "pending",
      gen: {
        generator: "flux3-klein",
        workflow: "workflows/flux3_klein_t2i.api.json",
        workflow_sha256: KLEIN_SHA,
        model: "flux-3-image-klein",
        caption: `A wide abstract nebula number ${index + 1}.`,
        inputs: { prompt: "A wide abstract nebula.", width: 960, height: 544, seed: 42 + index, steps: 16 },
      },
      model_license: { id: "LicenseRef-FLUX.3-Image-Klein" },
    };
    // Paid work must be reachable from an actual render placement.
    pkg.scenes[index].background = { asset: assetId, fit: "cover" };
  }
  return pkg;
}

function jobsFor(pkg) {
  return planJobs(pkg).jobs;
}

function manifestForJob(doc, job, content) {
  return {
    v: 1,
    run_id: "run_ip09",
    jobsHash: doc.hash,
    packageId: "pkg_ip09collect",
    complete: true,
    counts: { succeeded: 1 },
    jobs: [
      {
        job: job.id,
        status: "succeeded",
        job_id: "job_ip09",
        attempt_id: "att_ip09_01",
        outputs: [mockOutput(job, content)],
      },
    ],
  };
}

/** The pipeline-worker layout: outDir and scratchDir are siblings, never the same directory. */
function colabWorkspace({ assetId = "a_ip09_still", failDownloads = 0 } = {}) {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-ip09-"));
  const runDir = join(work, "run");
  const workDir = join(runDir, "work");
  const outDir = join(runDir, "media-out");
  const scratchDir = join(runDir, "media-runtime");
  mkdirSync(workDir, { recursive: true });

  const pkg = fixture(assetId);
  const doc = planJobs(pkg);
  const [job] = doc.jobs;
  const content = "IP09-COLLECTED-BYTES";
  const manifest = manifestForJob(doc, job, content);
  const capture = mockCapture(job);

  const fake = installFakeColab(work, {
    state: {
      usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
      sessions: "No active sessions found on server.\n",
      failDownloads,
      scripts: {
        "health.py": {
          output: 'HEALTH {"v":1,"ok":true,"detail":"all checks passed"}',
          files: [{ path: "/content/comfyrizz/out/health.json", content: JSON.stringify({ ok: true, detail: "all checks passed" }) }],
        },
        "run_jobs.py": {
          output: JSON.stringify({ v: 1, event: "job_done", job: job.id }),
          files: [
            { path: "/content/comfyrizz/out/manifest.json", content: JSON.stringify(manifest) },
             { path: `/content/comfyrizz/out/${job.output}`, content },
             { path: `/content/comfyrizz/out/${capture.relative}`, content: capture.content },
          ],
        },
      },
    },
  });

  const backend = createColabBackend({
    cli: makeCli(fake),
    packageId: "pkg_ip09collect",
    scratchDir,
    logDir: join(fake.tmpDir, "logs"),
    budgetUnits: 100,
    watchdogMinutes: 0,
    teardownRetryMs: 5,
  });
  // RunPackage has already been proven to bootstrap elsewhere; this test is about collect/verify/apply.
  delete backend.bootstrap;

  return { work, runDir, workDir, outDir, scratchDir, pkg, job, content, manifest, fake, backend };
}

test("runPackage verifies where Google Colab collected, without a second download pass", async () => {
  const ws = colabWorkspace();
  const events = [];
  const result = await runPackage(ws.backend, ws.pkg, {
    workDir: ws.workDir,
    outDir: ws.outDir,
    approved: true,
    teardownMode: "done",
    gateCommand: null,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true, JSON.stringify(result.verification));
  assert.equal(result.verification.verified, true, JSON.stringify(result.verification.problems));
  assert.equal(result.verification.dir, join(ws.scratchDir, "out"), "verification must use the backend's collected dir");
  assert.equal(result.applied.length, 1);
  assert.equal(result.package.assets.a_ip09_still.status, "ready");
  assertCollectedReceipt(result, "a_ip09_still");

  assert.equal(events.filter((event) => event.phase === "collecting").length, 0, "a clean run must not collect again");
  assert.equal(events.filter((event) => event.event === "collect_retry").length, 0);
  assert.ok(events.some((event) => event.phase === "verified"));

  const execs = readLog(ws.fake.logPath)
    .filter((entry) => entry.argv[0] === "exec")
    .map((entry) => entry.argv[entry.argv.indexOf("-f") + 1]);
  assert.equal(execs.filter((name) => String(name).endsWith("list_out.py")).length, 1, `one download_tree pass, got ${execs.join(",")}`);
  assert.equal(
    readLog(ws.fake.logPath).filter((entry) => entry.argv[0] === "download" && String(entry.argv[3]).endsWith(ws.job.output)).length,
    1,
    "the output was downloaded once, not once into each of two directories",
  );
  assert.equal(existsSync(join(ws.outDir, ...ws.job.output.split("/"))), false, "no duplicate collection into the caller's outDir");
});

test("a failed collect retries from the VM's existing tree without re-running inference", async () => {
  const ws = colabWorkspace({ failDownloads: 1 });
  // Keep the health probe out of the download budget so the single injected failure lands in the
  // collect (the fake fails downloads in order, not by path).
  ws.backend.health = async () => ({ ok: true, detail: "stub" });
  const events = [];
  const result = await runPackage(ws.backend, ws.pkg, {
    workDir: ws.workDir,
    outDir: ws.outDir,
    approved: true,
    teardownMode: "done",
    gateCommand: null,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true, JSON.stringify(result.verification));
  assert.equal(result.verification.verified, true, JSON.stringify(result.verification.problems));
  assert.equal(result.verification.attempts, 1, "one collect retry was enough");
  assert.equal(result.applied.length, 1);
  assert.ok(events.some((event) => event.event === "collect_retry"), "the retry is on the event log");
  assertCollectedReceipt(result, "a_ip09_still");
  assert.ok(events.some((event) => event.phase === "collecting"));

  const execs = readLog(ws.fake.logPath)
    .filter((entry) => entry.argv[0] === "exec")
    .map((entry) => entry.argv[entry.argv.indexOf("-f") + 1]);
  assert.equal(execs.filter((name) => String(name).endsWith("run_jobs.py")).length, 1, "inference ran exactly once");
  assert.equal(execs.filter((name) => String(name).endsWith("reconcile.py")).length, 0, "a collect retry never reconciles the batch");
  assert.equal(execs.filter((name) => String(name).endsWith("list_out.py")).length, 2, "the original collect plus one retry");
});

test("verification re-hashes sha256 and refuses paths that escape the collected directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-ip09-verify-"));
  const content = "VERIFY-ME";
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "ok.png"), content);

  const good = {
    jobs: [{ job: "a.still", status: "succeeded", outputs: [{ relative: "assets/ok.png", sha256: sha256(content), bytes: Buffer.byteLength(content) }] }],
  };
  assert.equal(verifyAgainstManifest(good, dir, { hashes: true }).verified, true);

  const tampered = {
    jobs: [{ job: "a.still", status: "succeeded", outputs: [{ relative: "assets/ok.png", sha256: sha256("SOMETHING-ELSE"), bytes: Buffer.byteLength(content) }] }],
  };
  const mismatch = verifyAgainstManifest(tampered, dir, { hashes: true });
  assert.equal(mismatch.verified, false);
  assert.match(mismatch.problems.join("\n"), /sha256/);
  assert.equal(mismatch.outputs[0].ok, false);

  for (const relative of ["../escape.png", "/etc/passwd", "assets/../../escape.png", "C:\\escape.png"]) {
    const escaping = {
      jobs: [{ job: "a.still", status: "succeeded", outputs: [{ relative, sha256: sha256(content), bytes: Buffer.byteLength(content) }] }],
    };
    const result = verifyAgainstManifest(escaping, dir, { hashes: true });
    assert.equal(result.verified, false, relative);
    assert.match(result.problems.join("\n"), /(absolute|escapes)/, relative);
  }
});

test("collect forces a fresh download after a bad digest and backend.verify never transfers", async () => {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-ip09-collect-"));
  const scratch = join(work, "scratch");
  const content = "REMOTE-BYTES";
  const manifest = {
    jobs: [{ job: "a.still", status: "succeeded", outputs: [{ relative: "assets/a.png", sha256: sha256(content), bytes: Buffer.byteLength(content) }] }],
  };
  const fake = installFakeColab(work, { state: { sessions: "No active sessions found on server.\n" } });
  const remote = join(fake.tmpDir, "remote", "out", "assets");
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "a.png"), content);
  const state = JSON.parse(readFileSync(fake.statePath, "utf8"));
  state.scripts = { "list_out.py": { walk: "/content/comfyrizz/out" } };
  writeFileSync(fake.statePath, JSON.stringify(state, null, 2));

  const backend = createColabBackend({
    cli: makeCli(fake),
    packageId: "pkg_ip09collect",
    scratchDir: scratch,
    logDir: join(fake.tmpDir, "logs"),
    watchdogMinutes: 0,
  });

  const dest = join(work, "collected");
  const first = await backend.collect(manifest, dest);
  assert.equal(first.verified, true, JSON.stringify(first.problems));

  const before = readLog(fake.logPath).length;
  const pure = await backend.verify(manifest, dest);
  assert.equal(pure.verified, true);
  assert.equal(readLog(fake.logPath).length, before, "verify must not issue a CLI command");

  writeFileSync(join(dest, "assets", "a.png"), "TAMPERED");
  assert.equal((await backend.verify(manifest, dest)).verified, false);

  const second = await backend.collect(manifest, dest);
  assert.equal(second.verified, true, JSON.stringify(second.problems));
  assert.equal(readFileSync(join(dest, "assets", "a.png"), "utf8"), content, "the bad local copy was replaced");
  assert.equal(second.skipped, 0, "a retry after a bad digest never trusts the remembered listing");
});

test("only verified outputs are applied; a good sibling survives a bad one", async () => {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-ip09-partial-"));
  const collected = join(work, "collected");
  const pkg = fixture("a_good_still", "a_bad_still");
  const jobs = jobsFor(pkg);
  assert.equal(jobs.length, 2);
  const good = jobs.find((job) => job.id.startsWith("a_good_still"));
  const bad = jobs.find((job) => job.id.startsWith("a_bad_still"));

  const backend = {
    id: "byo-comfyui",
    async describe() {
      return { label: "stub", costVisibility: "free" };
    },
    async estimate() {
      return { gpuMinutes: 0.1, overheadMinutes: 0 };
    },
    async health() {
      return { ok: true, detail: "stub" };
    },
    async run() {
      const goodContent = "GOOD-TAKE";
      const badContent = "BAD-TAKE";
      mkdirSync(join(collected, dirname(good.output)), { recursive: true });
      mkdirSync(join(collected, dirname(bad.output)), { recursive: true });
      writeFileSync(join(collected, good.output), goodContent);
      writeFileSync(join(collected, bad.output), badContent);
      return {
        manifest: {
          v: 1,
          complete: true,
          counts: { succeeded: 2 },
          jobs: [
            { job: good.id, status: "succeeded", job_id: "job-good", outputs: [{ relative: good.output, sha256: sha256(goodContent), bytes: Buffer.byteLength(goodContent) }] },
            // the remote record says one thing, the bytes say another: this take is never applied
            { job: bad.id, status: "succeeded", job_id: "job-bad", outputs: [{ relative: bad.output, sha256: sha256("SOMETHING-ELSE"), bytes: Buffer.byteLength(badContent) }] },
          ],
        },
        collect: { local: collected },
      };
    },
    async verify(manifest, dir) {
      return verifyAgainstManifest(manifest, dir, { hashes: true });
    },
    async teardown() {
      return { state: "stopped", evidence: "stub" };
    },
  };

  const result = await runPackage(backend, pkg, {
    workDir: join(work, "work"),
    outDir: join(work, "out"),
    teardownMode: "done",
    gateCommand: null,
  });

  assert.equal(result.ok, false, "an unverified output means the run is not ok");
  assert.equal(result.verification.verified, false);
  assert.equal(result.verification.problems.length, 1);
  assert.match(result.verification.problems[0], /sha256/);
  assert.deepEqual(result.applied.map((entry) => entry.asset), ["a_good_still"]);
  assert.equal(result.package.assets.a_good_still.status, "ready");
  assert.notEqual(result.package.assets.a_bad_still.status, "ready", "a mismatched file is never applied");
});

test("production scratch is per production, path-safe, and never defaults inside the repository", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "comfyrizz-ip09-runtime-"));
  assert.equal(
    productionScratchDir({ productionId: "prod_123", runtimeDir }),
    join(runtimeDir, "productions", "prod_123", "scratch"),
  );
  for (const productionId of ["../escape", "a/b", "a\\b", ".hidden", "", ".."]) {
    assert.throws(() => productionScratchDir({ productionId, runtimeDir }), /path-safe productionId/, productionId);
  }
  assert.throws(() => productionScratchDir({ productionId: "prod_123", runtimeDir: null }), /runtimeDir/, "no repo fallback");

  const work = mkdtempSync(join(tmpdir(), "comfyrizz-ip09-scratch-"));
  const fake = installFakeColab(work, { state: { sessions: "No active sessions found on server.\n" } });
  const cli = makeCli(fake);

  const production = createColabBackend({ cli, packageId: "pkg_ip09scratch", productionId: "prod_123", runtimeDir, watchdogMinutes: 0 });
  assert.equal(production.inspect().scratch, join(runtimeDir, "productions", "prod_123", "scratch"));

  const legacy = createColabBackend({ cli, packageId: "pkg_ip09legacy", runtimeDir, watchdogMinutes: 0 });
  const expected = join(process.env.TMPDIR || "/tmp", "comfyrizz-colab-pkg_ip09legacy");
  assert.equal(legacy.inspect().scratch, expected, "without a production id the old per-package temp default stays");
  assert.ok(!legacy.inspect().scratch.startsWith(REPO), "the fallback must never be in the repository");

  rmSync(legacy.inspect().scratch, { recursive: true, force: true });
  rmSync(production.inspect().scratch, { recursive: true, force: true });
  assert.equal(statSync(runtimeDir).isDirectory(), true);
});
