// B6 acceptance: Google Colab hardening against fakes.
//
// Every failure case ends with the VM verifiably stopped or `stop_unconfirmed` surfaced, nothing is
// auto-resubmitted, and the budget is never exceeded. Fakes only: the fake `colab` executable
// (test/bin/fake-colab.mjs) and the fake Comfy v2 server (pipeline-py/tests/fake_comfy_server.py).
// No real Google Colab call is made anywhere in this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createColabBackend } from "../src/colab-backend.mjs";
import { createByoBackend } from "../src/byo-backend.mjs";
import { settleScratchProcesses } from "./helpers.mjs";
import { installFakeColab, makeCli, readLog, readState, writeState } from "./helpers.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const PYTHON = join(REPO, ".venv", "bin", "python");
const FAKE_SERVER = join(REPO, "pipeline-py", "tests", "fake_comfy_server.py");
const PLAN_FIXTURE = join(REPO, "pipeline-py", "tests", "fixtures");
const HAVE_PYTHON = existsSync(PYTHON);

const children = [];
const backends = [];
const scratchRoots = [];

test.after(() => {
  for (const backend of backends) {
    try {
      const pid = backend.inspect?.().proxyPid;
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

function register(backend) {
  backends.push(backend);
  return backend;
}

/** A workspace with the five-job plan (stills, plate, upscale, audio) and its workflows. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-b6-"));
  scratchRoots.push(dir);
  copyFileSync(join(PLAN_FIXTURE, "jobs.json"), join(dir, "jobs.json"));
  symlinkSync(join(PLAN_FIXTURE, "workflows"), join(dir, "workflows"));
  mkdirSync(join(dir, "out"), { recursive: true });
  return dir;
}

/** The VM's own output directory, as the fake colab sees it: the runner writes these. */
function stageVmOutput(fake, jobsDoc, outDir, { complete = true } = {}) {
  const state = readState(fake.statePath);
  const files = [];
  const assets = outDir || fake.tmpDir;
  const jobs = complete ? jobsDoc.jobs.filter((job) => job.kind !== "upscale" || true) : [];
  const entries = [];
  for (const job of jobs) {
    const contents = `FAKE-${job.id}-BYTES`;
    files.push({ path: `/content/comfyrizz/out/${job.output}`, content: contents });
    entries.push({
      job: job.id,
      status: "succeeded",
      attempt_id: `att_${job.id}_01`,
      job_id: `job_${job.id}`,
      outputs: [{ file: job.output, relative: job.output, sha256: "0".repeat(64), bytes: contents.length }],
    });
  }
  files.push({
    path: "/content/comfyrizz/out/manifest.json",
    content: JSON.stringify({ v: 1, run_id: "b6", jobsHash: jobsDoc.hash, complete, counts: {}, jobs: entries }),
  });
  state.scripts = {
    ...(state.scripts || {}),
    "run_jobs.py": { output: '{"v":1,"event":"job_done","value":1}', files },
  };
  writeFileSync(fake.statePath, JSON.stringify(state, null, 2));
  return { assets, entries };
}

function colabBackendFor({ dir, fake, budgetUnits = 20, options = {} }) {
  return register(
    createColabBackend({
      cli: makeCli(fake),
      packageId: "pkg_b6hardening01",
      scratchDir: join(dir, "scratch"),
      logDir: join(fake.tmpDir, "logs"),
      packageDir: null,
      jobsFile: join(dir, "jobs.json"),
      budgetUnits,
      hfTokenPath: null,
      teardownRetryMs: 5,
      watchdogMinutes: 0.02,
      ...options,
    }),
  );
}

function plan(dir) {
  return JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
}

function commands(fake) {
  return readLog(fake.logPath).map((entry) => entry.argv[0]);
}

test("a lost exec mid-package reconciles, and the VM is still verifiably stopped", async (t) => {
  if (!HAVE_PYTHON) return t.skip("no venv python");
  const dir = workspace();
  const doc = plan(dir);
  const fake = installFakeColab(dir, {
    state: { usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n", scripts: { "run_jobs.py": { lost: true } } },
  });
  const backend = colabBackendFor({ dir, fake, options: { script: null } });
  await backend.ensureUp({ approved: true });

  const run = await backend.run(join(dir, "jobs.json"));
  assert.equal(run.lost, true);
  assert.equal(run.batchesRun.length, 1, "the first batch was the one that was lost");

  const execs = readLog(fake.logPath).filter((entry) => entry.argv[0] === "exec").map((entry) => entry.argv[entry.argv.indexOf("-f") + 1]);
  assert.deepEqual(execs, ["run_jobs.py", "reconcile.py"], "the batch ran once and reconciled once");

  const teardown = await backend.teardown("error");
  assert.equal(teardown.state, "stopped", "a lost exec still ends with a verified stop");
  assert.match(teardown.evidence, /no longer lists/);
  assert.ok(!commands(fake).includes("attach"));
});

test("a collect that fails still stops the VM and keeps the manifest honest", async (t) => {
  if (!HAVE_PYTHON) return t.skip("no venv python");
  const dir = workspace();
  const doc = plan(dir);
  const fake = installFakeColab(dir, { state: { usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n" } });
  stageVmOutput(fake, doc, dir);
  const state = readState(fake.statePath);
  state.failDownloads = 99; // every collect fails
  writeFileSync(fake.statePath, JSON.stringify(state, null, 2));

  const backend = colabBackendFor({ dir, fake });
  await backend.ensureUp({ approved: true });
  const run = await backend.run(join(dir, "jobs.json"));

  assert.equal(run.manifest, null, "a failed collect cannot produce a manifest");
  assert.equal(run.collect.ok, false);
  const execsBefore = readLog(fake.logPath).filter((entry) => entry.argv[0] === "exec").length;
  const teardown = await backend.teardown("error");
  assert.equal(teardown.state, "stopped");
  // a collect failure never resubmits: no further exec ran, and the failed run is still on record
  assert.equal(readLog(fake.logPath).filter((entry) => entry.argv[0] === "exec").length, execsBefore);
  assert.ok(
    backend.inspect().events.some((event) => event.type === "collect_failed" || event.type === "collect"),
    JSON.stringify(backend.inspect().events.map((event) => event.type)),
  );
});

test("stop fails twice, then succeeds: the VM is stopped, not abandoned", async () => {
  const dir = workspace();
  const fake = installFakeColab(dir, {
    state: { usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n", stopFailsTimes: 2 },
  });
  const backend = colabBackendFor({ dir, fake });
  await backend.ensureUp({ approved: true });

  const teardown = await backend.teardown("done");
  assert.equal(teardown.state, "stopped", JSON.stringify(teardown));
  assert.equal(teardown.attempts, 3, "two failures, then the stop that worked");
  const stops = readLog(fake.logPath).filter((entry) => entry.argv[0] === "stop");
  assert.equal(stops.length, 3);
  assert.deepEqual(readState(fake.statePath).stopFailCount, 2);
});

test("stop that never confirms is surfaced as stop_unconfirmed, with the manual command", async () => {
  const dir = workspace();
  const fake = installFakeColab(dir, { state: { usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n", keepAfterStop: true } });
  const backend = colabBackendFor({ dir, fake, options: { teardownRetries: 3 } });
  await backend.ensureUp({ approved: true });

  const teardown = await backend.teardown("user");
  assert.equal(teardown.state, "stop_unconfirmed");
  assert.match(teardown.evidence, /units are draining/);
  assert.equal(teardown.manual, "colab stop -s comfyrizz-b6hardening01");
  assert.equal(readLog(fake.logPath).filter((entry) => entry.argv[0] === "stop").length, 3);
});

test("the wall-clock cap refuses before anything is submitted", async (t) => {
  if (!HAVE_PYTHON) return t.skip("no venv python");
  const dir = workspace();
  const fake = installFakeColab(dir, { state: { usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n" } });
  const backend = colabBackendFor({ dir, fake, budgetUnits: 500, options: { wallClockCapMinutes: 0.0001 } });
  await backend.ensureUp({ approved: true });
  backend.state.startedAtMs = Date.now() - 60000;

  const run = await backend.run(join(dir, "jobs.json"));
  assert.equal(run.refused, true);
  assert.equal(run.reason, "wall_clock");
  assert.match(run.message, /Wall-clock cap reached/);
  const seen = commands(fake);
  assert.ok(!seen.includes("upload"), "nothing was uploaded for a refused run");
  assert.ok(!seen.includes("exec"), "nothing was executed for a refused run");
  const teardown = await backend.teardown("budget");
  assert.equal(teardown.state, "stopped");
});

test("the reserve formula refuses mid-package, and the budget is never exceeded", async (t) => {
  if (!HAVE_PYTHON) return t.skip("no venv python");
  const dir = workspace();
  const doc = plan(dir);
  const fake = installFakeColab(dir, { state: { usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n" } });
  stageVmOutput(fake, doc, dir, { complete: false });
  // H7 made the per-job minutes measured instead of placeholders (still 0.15, plate 0.5), so the
  // split budget is smaller than it used to be: admitting the stills batch needs 0.95 units
  // (its 0.06 upper bound plus the 0.89 collect-and-stop reserve), and the plate batch on top of
  // that needs 1.05 (committed 0.06 + its 0.10 upper bound + the reserve). 1.00 admits the first
  // and refuses the second.
  const backend = colabBackendFor({ dir, fake, budgetUnits: 1.0 });
  await backend.ensureUp({ approved: true });

  const run = await backend.run(join(dir, "jobs.json"));
  assert.equal(run.refused, true, JSON.stringify(run).slice(0, 300));
  assert.equal(run.reason, "refused");
  assert.match(run.message, /Refusing the next job/);
  assert.equal(run.batchesRun.length, 1, "the first batch ran, the second was refused");
  assert.deepEqual(run.batchesRun.map((entry) => entry.batch), ["stills"]);

  const uploads = readLog(fake.logPath).filter((entry) => entry.argv[0] === "upload");
  assert.equal(uploads.length, 2, "one bundle upload plus one batch selector");
  const selector = uploads.map((entry) => entry.argv[4]).find((remote) => String(remote).endsWith("batch.txt"));
  assert.equal(selector, "/content/comfyrizz/batch.txt");
  assert.ok(backend.inspect().events.some((event) => event.type === "refused"));

  const teardown = await backend.teardown("budget");
  assert.equal(teardown.state, "stopped");
  assert.ok(doc.batches.length > 1, "the fixture really is a multi-batch plan");
});

test("the BYO path surfaces submission_unknown and never resubmits it", async (t) => {
  if (!HAVE_PYTHON) return t.skip("no venv python");
  const dir = workspace();
  const requestLog = join(dir, "requests.jsonl");
  const fake = spawn(PYTHON, [FAKE_SERVER, "--port", "0", "--lifetime-seconds", "90", "--drop-first-response", "--request-log", requestLog], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(fake);
  const port = await new Promise((res, rej) => {
    let buffer = "";
    const timer = setTimeout(() => rej(new Error("fake did not start")), 10000);
    fake.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = /listening on (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        res(Number(match[1]));
      }
    });
  });
  const comfyui = await new Promise((res, rej) => {
    const other = spawn(PYTHON, [FAKE_SERVER, "--port", "0", "--lifetime-seconds", "90"], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(other);
    let buffer = "";
    const timer = setTimeout(() => rej(new Error("fake comfyui did not start")), 10000);
    other.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = /listening on (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        res(Number(match[1]));
      }
    });
  });

  const backend = register(
    createByoBackend({
      comfyuiUrl: `http://127.0.0.1:${comfyui}`,
      port,
      pythonBin: PYTHON,
      runnerTimeoutSeconds: 20,
      healthTimeoutMs: 5000,
      outDir: join(dir, "out"),
      jobsFile: join(dir, "jobs.json"),
      jobsDoc: plan(dir),
    }),
  );
  const first = await backend.run(join(dir, "jobs.json"));
  const unknown = first.manifest.jobs.filter((entry) => entry.status === "submission_unknown");
  assert.equal(unknown.length, 1, JSON.stringify(first.manifest.counts));
  assert.equal(unknown[0].error.code, "transport_ambiguous");
  assert.equal(first.manifest.complete, false);

  const posts = () => readFileSync(requestLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const submitsOf = (label) => posts().filter((entry) => entry.method === "POST" && entry.path === "/api/v2/jobs" && entry.label === label);
  const jobPosts = () => posts().filter((entry) => entry.method === "POST" && entry.path === "/api/v2/jobs");
  const labelsBefore = new Set(jobPosts().map((entry) => entry.label));
  const firstJob = plan(dir).jobs[0].id;
  assert.equal(submitsOf(firstJob).length, 1, "exactly one submission reached the server before the reply was lost");
  const second = await backend.run(join(dir, "jobs.json"));
  assert.equal(submitsOf(firstJob).length, 1, "the ambiguous job was resubmitted");
  // the second pass may re-run jobs that failed for ordinary reasons, but it can only ever send
  // labels the first run already sent: nothing new is invented for an unresolved job
  assert.ok(
    jobPosts().every((entry) => labelsBefore.has(entry.label)),
    JSON.stringify([...new Set(jobPosts().map((entry) => entry.label))].filter((label) => !labelsBefore.has(label))),
  );
  assert.ok(second.manifest.jobs.some((entry) => entry.status === "submission_unknown" || entry.status === "skipped"));
  assert.equal(
    second.manifest.jobs.filter((entry) => entry.job === firstJob)[0].status,
    "submission_unknown",
    "the second run still reports the ambiguous job as unresolved, never as done",
  );
});

test("the orphan reaper lists stale sessions and offers stop, never deletes", async () => {
  const dir = workspace();
  const fake = installFakeColab(dir, {
    state: { usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 2\n" },
  });
  const backend = colabBackendFor({ dir, fake });
  await backend.ensureUp({ approved: true });
  // `colab new` writes the one session we just made, so the list the reaper scans is set after
  // startup: ours, one stale comfyrizz-* session, and one that is not ours at all
  const state = readState(fake.statePath);
  state.sessions =
    "[comfyrizz-b6hardening01] live | Hardware: G4 | Shape: STANDARD | Variant: GPU | Status: IDLE\n" +
    "[comfyrizz-staleone] old | Hardware: G4 | Shape: STANDARD | Variant: GPU | Status: IDLE\n" +
    "[name-that-is-not-ours] someone | Hardware: T4 | Shape: STANDARD | Variant: GPU | Status: BUSY\n";
  writeState(fake.statePath, state);

  const { offers, autoStopped, scanned } = await backend.orphans();
  assert.equal(scanned, 3);
  assert.deepEqual(offers.map((offer) => offer.session), ["comfyrizz-staleone"], "only the stale comfyrizz-* session is offered");
  assert.deepEqual(autoStopped, []);
  assert.ok(offers[0].offer.startsWith("colab stop -s"));
  assert.match(offers[0].note, /user's decision/);
  const stops = readLog(fake.logPath).filter((entry) => entry.argv[0] === "stop");
  assert.deepEqual(stops, [], "the reaper must stop nothing");

  const spend = await backend.usage().then(() => backend.spend());
  assert.equal(spend.label, "estimate");
  assert.match(spend.detail, /other sessions running/, "an account with more assignments than ours says so");
  assert.equal(spend.assignments, 2);
});

test("a confirmed stop disarms the detached watchdog, an unconfirmed one keeps it armed", async () => {
  const dir = workspace();
  const fake = installFakeColab(dir, { state: { usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n" } });
  const backend = colabBackendFor({ dir, fake, options: { watchdogMinutes: 5 } });
  await backend.ensureUp({ approved: true });
  const armed = backend.inspect().watchdog;
  assert.ok(armed?.pid, "the run armed a detached watchdog");

  const stopped = await backend.teardown("done");
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.watchdog.disarmed, true, "a stopped VM has nothing left for the watchdog to stop");
  // and the process really is gone, not merely recorded as gone
  assert.throws(() => process.kill(armed.pid, 0), /ESRCH/, "the watchdog process must not outlive the run");

  const stubborn = installFakeColab(join(dir, "second"), {
    state: { usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n", keepAfterStop: true },
  });
  const other = colabBackendFor({ dir: join(dir, "second"), fake: stubborn, options: { teardownRetries: 1, watchdogMinutes: 5 } });
  await other.ensureUp({ approved: true });
  const otherArmed = other.inspect().watchdog;
  const unconfirmed = await other.teardown("error");
  assert.equal(unconfirmed.state, "stop_unconfirmed");
  assert.equal(unconfirmed.watchdog.disarmed, false, "an unconfirmed stop leaves the last line of defence armed");
  assert.doesNotThrow(() => process.kill(otherArmed.pid, 0), "the watchdog is still alive for the unconfirmed case");
  process.kill(otherArmed.pid, "SIGKILL");
});

test("no test process is left behind by the hardening cases", async () => {
  // the fakes are spawned with a bounded lifetime and killed in test.after; this check is about
  // the *detached* children (the watchdog, a proxy) that nothing else would reap, so it first
  // stops everything this file registered and then looks for survivors
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const backend of backends) {
    try {
      const pid = backend.inspect?.().proxyPid;
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // scoped to *this* file's scratch directories: other files' fake servers are legitimately alive
  // while the suite runs, and each of those files asserts its own cleanup (colab-backend.test.mjs
  // reaps any watchdog it armed). A survivor here is a process nothing would ever stop - but a
  // detached watchdog has a deadline to reach first, so wait for it (H10).
  const ours = await settleScratchProcesses(scratchRoots);
  assert.deepEqual(ours, []);
  assert.ok(scratchRoots.length > 0);
});
