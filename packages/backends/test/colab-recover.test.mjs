// IP10: recover an already-collected Google Colab output after a restart.
//
// The failure these tests exist for is a paid one. A run can finish collecting into its per-production
// scratch directory (`<scratch>/out`) and then the process dies before the manifest is applied. On
// restart the backend must verify that local tree and apply it, not allocate another VM and submit the
// same plan again. Every test uses the fake `colab` executable; nothing here talks to Google Colab or
// the network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createColabBackend } from "../src/colab-backend.mjs";
import { planJobs } from "../../jobs/src/index.mjs";
import { installFakeColab, makeCli, readLog } from "./helpers.mjs";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const LAUNCH_DEMO = join(REPO, "examples", "launch-demo", "package.json");
const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A valid package with one pending generated still. */
function fixture(assetId = "a_ip10_still") {
  const pkg = JSON.parse(readFileSync(LAUNCH_DEMO, "utf8"));
  pkg.id = "pkg_ip10recover";
  pkg.assets[assetId] = {
    kind: "image",
    origin: "generated",
    status: "pending",
    gen: {
      generator: "flux3-klein",
      workflow: "workflows/flux3_klein_t2i.api.json",
      workflow_sha256: SHA,
      model: "flux-3-image-klein",
      caption: "A wide abstract nebula for the recovery test.",
      inputs: { prompt: "A wide abstract nebula.", width: 960, height: 544, seed: 11, steps: 16 },
    },
    model_license: { id: "LicenseRef-FLUX.3-Image-Klein" },
  };
  return pkg;
}

function manualManifest(doc, job, content, { complete = true, jobsHash = doc.hash } = {}) {
  return {
    v: 1,
    run_id: "run_ip10",
    jobsHash,
    packageId: doc.packageId,
    complete,
    counts: complete ? { succeeded: 1 } : { pending: 1 },
    jobs: [
      {
        job: job.id,
        status: complete ? "succeeded" : "pending",
        job_id: "job_ip10",
        attempt_id: "att_ip10_01",
        outputs: complete
          ? [{ file: job.output, relative: job.output, sha256: sha256(content), bytes: Buffer.byteLength(content) }]
          : [],
      },
    ],
  };
}

function workspace({ assetId = "a_ip10_still" } = {}) {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-ip10-"));
  const scratch = join(work, "scratch");
  mkdirSync(scratch, { recursive: true });
  const pkg = fixture(assetId);
  const doc = planJobs(pkg);
  const [job] = doc.jobs;
  const jobsFile = join(work, "jobs.json");
  writeFileSync(jobsFile, `${JSON.stringify(doc, null, 2)}\n`);
  return { work, scratch, pkg, doc, job, jobsFile };
}

/** Lay down what a collect has already downloaded, exactly where the backend keeps it. */
function stageCollected(ws, content, options = {}) {
  const outDir = join(ws.scratch, "out");
  const target = join(outDir, ...ws.job.output.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  const manifest = manualManifest(ws.doc, ws.job, content, options);
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest));
  return { outDir, target, manifest };
}

test("a restarted backend recovers collected output without calling Google Colab", async () => {
  const ws = workspace();
  const content = "IP10-COLLECTED-BYTES";
  const manifest = manualManifest(ws.doc, ws.job, content);
  const fake = installFakeColab(ws.work, {
    state: {
      uploadCreatesDirs: true,
      scripts: {
        "run_jobs.py": {
          output: JSON.stringify({ v: 1, event: "job_done", job: ws.job.id }),
          files: [
            { path: "/content/comfyrizz/out/manifest.json", content: JSON.stringify(manifest) },
            { path: `/content/comfyrizz/out/${ws.job.output}`, content },
          ],
        },
      },
    },
  });
  const makeBackend = () =>
    createColabBackend({
      cli: makeCli(fake),
      packageId: ws.doc.packageId,
      scratchDir: ws.scratch,
      logDir: join(fake.tmpDir, "logs"),
      budgetUnits: 100,
      watchdogMinutes: 0,
      teardownRetryMs: 5,
    });

  // The first process runs and collects, then is thrown away (a restart).
  const before = makeBackend();
  const first = await before.run(ws.jobsFile);
  assert.equal(first.manifest.complete, true, JSON.stringify(first.manifest));
  assert.equal(existsSync(join(ws.scratch, "out", "manifest.json")), true, "the first run collected a manifest");
  assert.equal(readLog(fake.logPath).length > 0, true);

  // The restarted backend sees the same scratch and has no in-memory collection map.
  const after = makeBackend();
  const logBefore = readLog(fake.logPath).length;
  const events = [];
  const second = await after.run(ws.jobsFile, (event) => events.push(event));

  assert.equal(second.recovered, true, JSON.stringify(second.recovery));
  assert.deepEqual(second.batchesRun, [], "nothing was submitted");
  assert.equal(second.manifest.complete, true);
  assert.equal(second.manifest.jobsHash, ws.doc.hash);
  assert.equal(second.collect.recovered, true);
  assert.equal(second.collect.verified, true, JSON.stringify(second.collect.problems));
  assert.equal(second.collect.local, join(ws.scratch, "out"));
  assert.equal(second.collect.fetched, 0, "recovery reads the local scratch tree, it does not download it again");
  assert.equal(readLog(fake.logPath).length, logBefore, "recovery must not invoke the Google Colab CLI");
  assert.ok(events.some((event) => event.type === "run_recovered"));
});

test("runPackage applies recovered output without allocating a session or uploading a bundle", async () => {
  const ws = workspace();
  const content = "IP10-APPLIED-BYTES";
  const staged = stageCollected(ws, content);
  const fake = installFakeColab(ws.work, {
    state: {
      sessions: "No active sessions found on server.\n",
      // A submit would fail the test loudly: no script is staged for it.
      scripts: {},
    },
  });
  const backend = createColabBackend({
    cli: makeCli(fake),
    packageId: ws.doc.packageId,
    scratchDir: ws.scratch,
    logDir: join(fake.tmpDir, "logs"),
    budgetUnits: 100,
    watchdogMinutes: 0,
    teardownRetryMs: 5,
  });

  const events = [];
  const result = await backend.runPackage(ws.pkg, {
    workDir: ws.work,
    outDir: join(ws.work, "media-out"),
    approved: true,
    gateCommand: null,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true, JSON.stringify(result.verification));
  assert.equal(result.manifest.jobsHash, ws.doc.hash);
  assert.equal(result.verification.verified, true, JSON.stringify(result.verification.problems));
  assert.equal(result.verification.dir, staged.outDir, "verification must use the scratch that was recovered");
  assert.equal(result.applied.length, 1);
  assert.equal(result.package.assets.a_ip10_still.status, "ready");
  assert.equal(result.up.state, "recovered");
  assert.equal(result.bootstrap.skipped, true, "a recovered run does not bootstrap a VM it did not start");
  assert.equal(result.health.recovered, true, "a recovered run does not health-check a VM it did not start");
  assert.equal(result.teardown.state, "not_owned");

  const invocations = readLog(fake.logPath).map((entry) => entry.argv[0]);
  assert.deepEqual(invocations, [], `recovery must not call the CLI: ${invocations.join(",")}`);
  assert.equal(existsSync(join(ws.scratch, "jobs.zip")), false, "no bundle is built for a recovered run");
});

test("recovery refuses a missing, incomplete, stale or tampered scratch output", async () => {
  const ws = workspace();
  const content = "IP10-VERIFY-ME";
  const fake = installFakeColab(ws.work, { state: { sessions: "No active sessions found on server.\n" } });
  const backend = createColabBackend({
    cli: makeCli(fake),
    packageId: ws.doc.packageId,
    scratchDir: ws.scratch,
    logDir: join(fake.tmpDir, "logs"),
    watchdogMinutes: 0,
  });
  const recover = () => backend.recoverCollected({ jobsFile: ws.jobsFile });

  const empty = await recover();
  assert.equal(empty.recovered, false);
  assert.match(empty.reason, /no collected output/i);

  const { target, outDir } = stageCollected(ws, content);
  writeFileSync(target, "IP10-TAMPEREDX");
  const tampered = await recover();
  assert.equal(tampered.recovered, false);
  assert.equal(tampered.verified, false);
  assert.ok(tampered.problems.some((problem) => /sha256/i.test(problem)), JSON.stringify(tampered.problems));

  const incomplete = manualManifest(ws.doc, ws.job, content, { complete: false });
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(incomplete));
  const notComplete = await recover();
  assert.equal(notComplete.recovered, false);
  assert.match(notComplete.reason, /not complete|pending/i);

  stageCollected(ws, content, { jobsHash: "f".repeat(64) });
  const stale = await recover();
  assert.equal(stale.recovered, false);
  assert.equal(stale.stale, true);
  assert.match(stale.reason, /different/i);
});
