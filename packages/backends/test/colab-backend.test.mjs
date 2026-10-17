// B3 acceptance: the Google Colab lifecycle against a FAKE `colab` executable on PATH.
// Zero real Google Colab calls: the fake never touches the network, and every assertion is
// read back from its argv log and state file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createColabBackend } from "../src/colab-backend.mjs";
import { readLog, installFakeColab, makeCli, readState } from "./helpers.mjs";

const ASSET_BYTES = "COMFYRIZZ-FAKE-PLATE-BYTES-0123456789";
const HF_TOKEN = "hf_FAKETOKENVALUE0123456789ABCDEF";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-b3-"));
  const jobsFile = join(dir, "jobs.json");
  writeFileSync(
    jobsFile,
    JSON.stringify({
      v: 1,
      hash: "a".repeat(64),
      packageId: "pkg_demo0001",
      jobs: [{ id: "a_cutout.still", kind: "still", batch: "stills", asset: "a_cutout", deps: [], output: "assets/a_cutout.png", cacheKey: "b".repeat(64), workflow: "workflows/flux3_klein_t2i.api.json" }],
    }),
  );
  const tokenPath = join(dir, "hf-token");
  writeFileSync(tokenPath, `${HF_TOKEN}\n`, { mode: 0o600 });
  return { dir, jobsFile, tokenPath };
}

function manifestFor(complete = true) {
  return {
    v: 1,
    run_id: "run1",
    jobsHash: "a".repeat(64),
    packageId: "pkg_demo0001",
    complete,
    counts: complete ? { succeeded: 1 } : { pending: 1 },
    jobs: complete
      ? [
          {
            job: "a_cutout.still",
            status: "succeeded",
            attempt_id: "att_a_cutout.still_01",
            job_id: "job_001",
            outputs: [{ file: "out/assets/a_cutout.png", relative: "assets/a_cutout.png", sha256: "c".repeat(64), bytes: ASSET_BYTES.length }],
          },
        ]
      : [],
  };
}

function baseState(overrides = {}) {
  return {
    usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
    sessions: "No active sessions found on server.\n",
    scripts: {
      "bootstrap.py": { output: "bootstrap done", files: [{ path: "/content/comfyrizz/out/ready.json", content: '{"ok":true,"comfyui":"0.41.0"}' }] },
      "health.py": { output: "health done", files: [{ path: "/content/comfyrizz/out/health.json", content: JSON.stringify({ ok: true, detail: "3 node types present", vramFreeGB: 82.1 }) }] },
      "run_jobs.py": {
        output: [
          JSON.stringify({ v: 1, attempt: "att_a_cutout.still_01", job: "a_cutout.still", seq: 1, event: "submitted", value: "job_001" }),
          JSON.stringify({ v: 1, attempt: "att_a_cutout.still_01", job: "a_cutout.still", seq: 2, event: "job_done", value: 1 }),
        ].join("\n"),
        files: [
          { path: "/content/comfyrizz/out/manifest.json", content: JSON.stringify(manifestFor(true)) },
          { path: "/content/comfyrizz/out/assets/a_cutout.png", content: ASSET_BYTES },
        ],
      },
      "reconcile.py": {
        output: "reconciled",
        files: [
          { path: "/content/comfyrizz/out/manifest.json", content: JSON.stringify(manifestFor(true)) },
          { path: "/content/comfyrizz/out/assets/a_cutout.png", content: ASSET_BYTES },
        ],
      },
    },
    ...overrides,
  };
}

function backendFor(fake, extra = {}) {
  const { dir, jobsFile, tokenPath } = extra.workspace;
  return createColabBackend({
    cli: makeCli(fake),
    packageId: "pkg_demo0001",
    scratchDir: join(dir, "scratch"),
    logDir: join(fake.tmpDir, "logs"),
    packageDir: null,
    budgetUnits: 20,
    hfTokenPath: tokenPath,
    jobsFile,
    teardownRetryMs: 5,
    ...extra.options,
  });
}

test("happy path: preflight, allocate, bootstrap, health, run, verified stop", async () => {
  const ws = workspace();
  const fake = installFakeColab(ws.dir, { state: baseState() });
  const backend = backendFor(fake, { workspace: ws });

  const preflight = await backend.preflight();
  assert.equal(preflight.ready, true, JSON.stringify(preflight.problems));
  assert.equal(preflight.usage.balance, 387.05);
  assert.equal(preflight.reusableSession, false);
  assert.equal(preflight.hfToken.mode, "0600 file, never --env");

  const up = await backend.ensureUp({ approved: true });
  assert.equal(up.state, "created");
  assert.equal(up.session, "comfyrizz-demo0001");

  await backend.bootstrap();
  const health = await backend.health();
  assert.equal(health.ok, true);
  assert.equal(health.vramFreeGB, 82.1);

  const run = await backend.run(ws.jobsFile);
  assert.equal(run.lost, false);
  assert.equal(run.manifest.complete, true);
  assert.equal(run.collect.verified, true, JSON.stringify(run.collect.problems));

  const teardown = await backend.teardown("done");
  assert.equal(teardown.state, "stopped");
  assert.match(teardown.evidence, /colab sessions no longer lists/);

  const commands = readLog(fake.logPath).map((entry) => entry.argv.join(" "));
  const order = readLog(fake.logPath).map((entry) => entry.argv[0]);
  assert.deepEqual(order.slice(0, 4), ["version", "usage", "sessions", "new"]);
  assert.ok(order.includes("upload") && order.includes("download") && order.includes("stop"));
  assert.ok(
    commands.some((line) => line.includes("exec -s comfyrizz-demo0001 -f bootstrap.py --timeout 900")),
    commands.join("\n"),
  );
  assert.ok(commands.some((line) => line.includes("upload -s comfyrizz-demo0001") && line.includes("/content/comfyrizz/.hf-token")));

  // the token itself is never an argument, never in the CLI environment, never in a log
  for (const entry of readLog(fake.logPath)) {
    assert.ok(!entry.argv.some((arg) => String(arg).includes("hf_FAKETOKEN")), "a token value reached an argv");
    assert.deepEqual(entry.env, [], "a token-shaped variable reached the CLI environment");
  }
  const allLogs = readLog(fake.logPath).length;
  assert.ok(allLogs > 5);
});

test("a lost exec reconciles on the VM and never re-runs the batch", async () => {
  const ws = workspace();
  const state = baseState();
  state.scripts["run_jobs.py"] = { lost: true }; // accepted, then the exec drops without a reply
  const fake = installFakeColab(ws.dir, { state });
  const backend = backendFor(fake, { workspace: ws });

  await backend.ensureUp({ approved: true });
  const run = await backend.run(ws.jobsFile);

  assert.equal(run.lost, true);
  assert.equal(run.manifest.complete, true, "reconcile collected the VM's own manifest");
  assert.equal(run.reconcile.execs, 1, "exactly one reconcile exec");
  assert.match(run.reconcile.note, /not resubmitted/);

  const execs = readLog(fake.logPath)
    .filter((entry) => entry.argv[0] === "exec")
    .map((entry) => entry.argv[entry.argv.indexOf("-f") + 1]);
  assert.deepEqual(execs, ["run_jobs.py", "reconcile.py"], "the batch script ran exactly once");
});

test("a stop the CLI accepts but the session survives is stop_unconfirmed", async () => {
  const ws = workspace();
  const fake = installFakeColab(ws.dir, { state: baseState({ keepAfterStop: true }) });
  const backend = backendFor(fake, { workspace: ws, options: { teardownRetries: 3 } });

  await backend.ensureUp({ approved: true });
  const teardown = await backend.teardown("user");

  assert.equal(teardown.state, "stop_unconfirmed");
  assert.match(teardown.evidence, /units are draining/);
  assert.match(teardown.evidence, /still lists comfyrizz-demo0001/);
  assert.equal(teardown.manual, "colab stop -s comfyrizz-demo0001");
  const stops = readLog(fake.logPath).filter((entry) => entry.argv[0] === "stop");
  assert.equal(stops.length, 3, "it retried before giving up");
  assert.deepEqual(readState(fake.statePath).stopCount, 3);
});

test("the reserve formula refuses the next job, and warns at 80%", async () => {
  const ws = workspace();

  const small = installFakeColab(ws.dir, { state: baseState() });
  const broke = backendFor(small, { workspace: ws, options: { budgetUnits: 0.5 } });
  const refused = await broke.run(ws.jobsFile);
  assert.equal(refused.refused, true);
  assert.equal(refused.reason, "refused");
  assert.match(refused.message, /Refusing the next job/);
  const refusedCommands = readLog(small.logPath).map((entry) => entry.argv[0]);
  assert.ok(!refusedCommands.includes("upload"), "nothing was uploaded for a refused job");
  assert.ok(!refusedCommands.some((command) => command === "exec"), "no exec for a refused job");

  const tight = installFakeColab(ws.dir, { state: baseState(), name: "colab-tight" });
  const warning = backendFor(tight, { workspace: ws, options: { budgetUnits: 2.4 } });
  const admitted = await warning.admit([{ kind: "still" }]);
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.warn, true, admitted.message);
  assert.match(admitted.message, /Warning/);
  assert.ok(admitted.decision.formula.length >= 5);
});

test("the wall-clock cap stops admission even when metering looks fine", async () => {
  const ws = workspace();
  const fake = installFakeColab(ws.dir, { state: baseState() });
  const backend = backendFor(fake, { workspace: ws, options: { budgetUnits: 500, wallClockCapMinutes: 0.0001 } });
  backend.state.startedAtMs = Date.now() - 60000;
  const admission = backend.admit([{ kind: "still" }]);
  assert.equal(admission.allowed, false);
  assert.equal(admission.reason, "wall_clock");
  assert.match(admission.message, /Wall-clock cap reached/);
});

test("unknown comfyrizz-* sessions are offered, never auto-stopped", async () => {
  const ws = workspace();
  const fake = installFakeColab(ws.dir, {
    state: baseState({
      sessions: "[comfyrizz-orphan] aaa | Hardware: T4 | Shape: STANDARD | Variant: GPU | Status: IDLE\n[someone-else] bbb | Hardware: G4 | Shape: STANDARD | Variant: GPU | Status: BUSY\n",
    }),
  });
  const backend = backendFor(fake, { workspace: ws });
  const { offers, autoStopped, scanned } = await backend.orphans();

  assert.equal(scanned, 2);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].session, "comfyrizz-orphan");
  assert.equal(offers[0].offer, "colab stop -s comfyrizz-orphan");
  assert.match(offers[0].note, /never automatic/);
  assert.deepEqual(autoStopped, []);
  assert.ok(!readLog(fake.logPath).some((entry) => entry.argv[0] === "stop"), "the reaper must not stop anything");
});

test("teardown of a session we do not own is not_owned, and stops nothing", async () => {
  const ws = workspace();
  const fake = installFakeColab(ws.dir, { state: baseState() });
  const backend = backendFor(fake, { workspace: ws });
  const teardown = await backend.teardown("user");
  assert.equal(teardown.state, "not_owned");
  assert.match(teardown.evidence, /nothing was stopped/);
  assert.ok(!readLog(fake.logPath).some((entry) => entry.argv[0] === "stop"));
});

test("a finished run reports spend as an estimate and names other sessions", async () => {
  const ws = workspace();
  const fake = installFakeColab(ws.dir, {
    state: baseState({ usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n" }),
  });
  const backend = backendFor(fake, { workspace: ws });
  await backend.preflight();
  backend.state.usageAfter = { balance: 386.64, ratePerHour: 8.9, assignments: 1 };
  const spend = backend.spend();
  assert.equal(spend.units, 0.41, "the Oct 16 measurement: 387.05 -> 386.64");
  assert.equal(spend.label, "estimate");
  assert.match(spend.detail, /estimate/);
});

test("provider keys are redacted out of every step log", async () => {
  const ws = workspace();
  const state = baseState();
  state.scripts["health.py"] = {
    output: "using ya29.faketokenvalue and hf_ANOTHERSECRETVALUE0123456789 for the download",
    files: [{ path: "/content/comfyrizz/out/health.json", content: JSON.stringify({ ok: true, detail: "fine" }) }],
  };
  const fake = installFakeColab(ws.dir, { state });
  const logs = [];
  const backend = createColabBackend({
    cli: makeCli(fake, { onLog: (text) => logs.push(text) }),
    packageId: "pkg_demo0001",
    scratchDir: join(ws.dir, "scratch"),
    logDir: join(fake.tmpDir, "logs"),
    packageDir: null,
    budgetUnits: 20,
    hfTokenPath: ws.tokenPath,
  });
  await backend.ensureUp({ approved: true });
  await backend.health();

  const joined = logs.join("\n");
  assert.ok(!joined.includes("ya29."), joined.slice(-200));
  assert.ok(!joined.includes("hf_ANOTHERSECRETVALUE0123456789"), joined.slice(-200));
  assert.ok(joined.includes("[redacted]"), joined.slice(-200));
  const healthLog = readdirSync(join(fake.tmpDir, "logs")).find((name) => name.startsWith("health"));
  const stepLog = readFileSync(join(fake.tmpDir, "logs", healthLog), "utf8");
  assert.ok(!stepLog.includes("hf_ANOTHERSECRETVALUE0123456789"));
});
