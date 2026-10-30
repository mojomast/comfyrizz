// IP16: a Google Colab run that is killed mid-collect resumes from the host's scratch.
//
// The dangerous window is after the paid batch has finished and while its out/ tree is being
// collected. If the host dies there, the work is already on the VM and partly on disk; a restart
// must verify what arrived and finish the apply, not allocate another session or submit the plan
// again. This test injects a real process kill: the fake Google Colab `download` hangs on a late
// file, the child running `runPackage` is SIGKILLed, and a fresh backend is pointed at the same
// scratch. Nothing here talks to Google Colab or the network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { ColabCli } from "../src/cli.mjs";
import { createColabBackend } from "../src/colab-backend.mjs";
import { planJobs } from "../../jobs/src/index.mjs";
import { FAKE_SOURCE, installFakeColab, readLog, readState } from "./helpers.mjs";
import { KLEIN_SHA, mockCapture, mockOutput, assertCollectedReceipt } from "./mock-generation.mjs";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const LAUNCH_DEMO = join(REPO, "examples", "launch-demo", "package.json");
const LATE_FILE = "zzz-ip16-late.bin";

/** A valid package with one pending generated still. */
function fixture(assetId = "a_ip16_still") {
  const pkg = JSON.parse(readFileSync(LAUNCH_DEMO, "utf8"));
  pkg.id = "pkg_ip16fault";
  pkg.assets[assetId] = {
    kind: "image",
    origin: "generated",
    status: "pending",
    gen: {
      generator: "flux3-klein",
      workflow: "workflows/flux3_klein_t2i.api.json",
      workflow_sha256: KLEIN_SHA,
      model: "flux-3-image-klein",
      caption: "A wide abstract nebula for the fault-injection test.",
      inputs: { prompt: "A wide abstract nebula.", width: 960, height: 544, seed: 16, steps: 16 },
    },
    model_license: { id: "LicenseRef-FLUX.3-Image-Klein" },
  };
  pkg.scenes[0].background = { asset: assetId, fit: "cover" };
  return pkg;
}

function manifestFor(doc, content) {
  const [job] = doc.jobs;
  return {
    v: 1,
    run_id: "run_ip16",
    jobsHash: doc.hash,
    packageId: doc.packageId,
    complete: true,
    counts: { succeeded: 1 },
    jobs: [
      {
        job: job.id,
        status: "succeeded",
        job_id: "job_ip16",
        attempt_id: "att_ip16_01",
        outputs: [mockOutput(job, content)],
      },
    ],
  };
}

/**
 * A fake `colab` wrapper that delegates every command to the shared fake, except the download of
 * `LATE_FILE`, which records its pid and hangs. The host is killed while that download is waiting,
 * exactly like a machine losing power in the middle of collect.
 */
function writingShim(dir) {
  const shim = join(dir, "fake-colab-ip16.mjs");
  writeFileSync(
    shim,
    [
      'import { spawnSync } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      "const argv = process.argv.slice(2);",
      'if (argv[0] === "download" && String(argv[3] || "").endsWith(process.env.IP16_HANG_REMOTE || "")) {',
      "  writeFileSync(process.env.IP16_HANG_MARKER, String(process.pid));",
      "  setInterval(() => {}, 1000);",
      "} else {",
      "  const result = spawnSync(process.execPath, [process.env.IP16_REAL_FAKE, ...argv], { stdio: 'inherit', env: process.env });",
      "  process.exit(result.status ?? 1);",
      "}",
      "",
    ].join("\n"),
  );
  return shim;
}

/** The child entry point: the real Google Colab backend through the real runPackage. */
function writingChild(dir) {
  const child = join(dir, "host-ip16.mjs");
  const importOf = (relative) => pathToFileURL(join(REPO, relative)).href;
  writeFileSync(
    child,
    [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      `import { ColabCli } from ${JSON.stringify(importOf("packages/backends/src/cli.mjs"))};`,
      `import { createColabBackend } from ${JSON.stringify(importOf("packages/backends/src/colab-backend.mjs"))};`,
      "const [workDir, scratchDir, pkgPath, binPath, statePath, logPath, markerPath] = process.argv.slice(2);",
      'const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));',
      "const cli = new ColabCli({",
      "  bin: binPath,",
      "  home: workDir,",
      '  logDir: join(workDir, "logs"),',
      "  extraEnv: {",
      "    FAKE_COLAB_STATE: statePath,",
      "    FAKE_COLAB_LOG: logPath,",
      "    IP16_REAL_FAKE: process.env.IP16_REAL_FAKE,",
      `    IP16_HANG_REMOTE: ${JSON.stringify(LATE_FILE)},`,
      "    IP16_HANG_MARKER: markerPath,",
      "  },",
      "});",
      "const backend = createColabBackend({",
      "  cli,",
      "  packageId: pkg.id,",
      "  scratchDir,",
      '  logDir: join(workDir, "logs"),',
      "  budgetUnits: 100,",
      "  watchdogMinutes: 0,",
      "  teardownRetryMs: 5,",
      "  progressDir: null,",
      "});",
      "// The bootstrap and health probes are proven elsewhere; this test is about collect/apply.",
      "backend.bootstrap = async () => ({ code: 0 });",
      'backend.health = async () => ({ ok: true, detail: "stub" });',
      "await backend.runPackage(pkg, {",
      "  workDir,",
      '  outDir: join(workDir, "media-out"),',
      "  approved: true,",
      '  teardownMode: "done",',
      "  gateCommand: null,",
      "});",
      "",
    ].join("\n"),
  );
  return child;
}

function waitFor(path, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      if (existsSync(path)) return resolvePromise();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${path}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("a run killed mid-collect resumes its verified output without paying for the batch again", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-ip16-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  const pkg = fixture();
  const doc = planJobs(pkg);
  const [job] = doc.jobs;
  const content = "IP16-COLLECTED-BYTES";
  const manifest = manifestFor(doc, content);
  const capture = mockCapture(job);
  const pkgPath = join(work, "package.json");
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const shim = writingShim(work);
  const fake = installFakeColab(work, {
    script: shim,
    state: {
      uploadCreatesDirs: true,
      sessions: "No active sessions found on server.\n",
      scripts: {
        "run_jobs.py": {
          output: JSON.stringify({ v: 1, event: "job_done", job: job.id }),
          files: [
             { path: `/content/comfyrizz/out/${job.output}`, content },
             { path: `/content/comfyrizz/out/${capture.relative}`, content: capture.content },
            { path: "/content/comfyrizz/out/manifest.json", content: JSON.stringify(manifest) },
            { path: `/content/comfyrizz/out/${LATE_FILE}`, content: "late" },
          ],
        },
      },
    },
  });

  const scratch = join(work, "scratch");
  const marker = join(work, "hanging-download.pid");
  const childScript = writingChild(work);
  const out = [];
  const child = spawn(process.execPath, [childScript, work, scratch, pkgPath, fake.bin, fake.statePath, fake.logPath, marker], {
    env: { ...process.env, IP16_REAL_FAKE: FAKE_SOURCE, COMFYRIZZ_RUNTIME: join(work, "runtime") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => out.push(chunk.toString()));
  child.stderr.on("data", (chunk) => out.push(chunk.toString()));

  // Wait for the download of the late file, then kill the host process outright: no teardown,
  // no apply, no chance to write a "finished" record.
  await waitFor(marker);
  const downloader = Number(readFileSync(marker, "utf8"));
  child.kill("SIGKILL");
  const [code, signal] = await once(child, "exit");
  try {
    process.kill(downloader, "SIGKILL");
  } catch {
    /* the downloader went away with the host */
  }
  assert.equal(signal, "SIGKILL", `the host was killed, got code=${code} signal=${signal}\n${out.join("")}`);

  // The batch finished and its verdict plus the output landed before the kill; the late sibling did not.
  const collected = join(scratch, "out");
  assert.equal(existsSync(join(collected, "manifest.json")), true, "the manifest was collected before the kill");
  assert.equal(existsSync(join(collected, ...job.output.split("/"))), true, "the output was collected before the kill");
  assert.equal(existsSync(join(collected, LATE_FILE)), false, "the kill landed mid-collect, not after it");
  assert.equal(readState(fake.statePath).stopped, false, "the killed host never reached teardown");
  assert.equal(readLog(fake.logPath).filter((entry) => entry.argv[0] === "stop").length, 0, "the kill landed before any stop was requested");

  const batchExecs = () =>
    readLog(fake.logPath)
      .filter((entry) => entry.argv[0] === "exec")
      .map((entry) => entry.argv[entry.argv.indexOf("-f") + 1])
      .filter((name) => String(name).endsWith("run_jobs.py")).length;
  const allocations = () => readLog(fake.logPath).filter((entry) => entry.argv[0] === "new").length;
  assert.equal(batchExecs(), 1, "the paid batch ran once before the fault");
  assert.equal(allocations(), 1, "one session was allocated before the fault");

  // A restart sees the same scratch and must finish from it.
  const cli = new ColabCli({
    bin: fake.bin,
    home: fake.tmpDir,
    logDir: join(work, "logs"),
    extraEnv: {
      FAKE_COLAB_STATE: fake.statePath,
      FAKE_COLAB_LOG: fake.logPath,
      IP16_REAL_FAKE: FAKE_SOURCE,
      IP16_HANG_REMOTE: LATE_FILE,
      IP16_HANG_MARKER: marker,
    },
  });
  const backend = createColabBackend({
    cli,
    packageId: pkg.id,
    scratchDir: scratch,
    logDir: join(work, "logs"),
    budgetUnits: 100,
    watchdogMinutes: 0,
    teardownRetryMs: 5,
    progressDir: null,
  });

  const events = [];
  const result = await backend.runPackage(pkg, {
    workDir: work,
    outDir: join(work, "media-out"),
    approved: true,
    teardownMode: "done",
    gateCommand: null,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true, JSON.stringify(result.verification));
  assert.equal(result.verification.verified, true, JSON.stringify(result.verification.problems));
  assert.equal(result.verification.dir, collected, "verification uses the scratch the killed host left behind");
  assert.equal(result.collect.recovered, true);
  assert.equal(result.up.state, "recovered");
  assert.equal(result.bootstrap.skipped, true, "a recovered run does not bootstrap a VM it did not start");
  assert.equal(result.health.recovered, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.package.assets.a_ip16_still.status, "ready");
  assertCollectedReceipt(result, "a_ip16_still");
  assert.equal(result.teardown.state, "stopped", "the VM that the killed host left is stopped and confirmed");
  assert.ok(events.some((event) => event.type === "collect_recovered"), JSON.stringify(events.map((event) => event.type)));
  assert.ok(events.some((event) => event.type === "run_recovered"));

  assert.equal(batchExecs(), 1, "the restart must not submit the paid batch again");
  assert.equal(allocations(), 1, "the restart must not allocate another session");
  const bundleUploads = readLog(fake.logPath).filter((entry) => entry.argv[0] === "upload" && String(entry.argv[3]).endsWith("jobs.zip"));
  assert.equal(bundleUploads.length, 1, "the restart must not upload a second jobs bundle");
  assert.equal(existsSync(join(work, "media-out", ...job.output.split("/"))), false, "recovery does not duplicate the tree into the caller's outDir");
});
