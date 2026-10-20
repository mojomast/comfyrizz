// Live gauges for Google Colab runs: the VM's colab_progress lines reach a per-run JSONL sink on the
// box, the snapshot reader folds them into the latest value of every gauge, and a fake-`colab` run
// shows the whole path (upload of the helper, stdout lines, sink file) without a real session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createColabProgressSink, readColabProgress, tapColabProgress, cleanGauge } from "../src/colab-progress.mjs";
import { progressLines } from "../src/progress-lines.mjs";
import { createColabBackend } from "../src/colab-backend.mjs";
import { installFakeColab, makeCli, readLog, settleScratchProcesses } from "./helpers.mjs";

const roots = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "comfyrizz-gauges-")); roots.push(dir); return dir; };
test.after(async () => { assert.deepEqual(await settleScratchProcesses(roots), []); });

const line = (fields) => JSON.stringify({ event: "colab_progress", v: 1, job: "p1", ts: "2026-10-20T19:00:00.000Z", ...fields });

test("colab_progress lines go to the sink, not the run's events; runner progress is mirrored", () => {
  const dir = scratch();
  const sink = createColabProgressSink({ runId: "s.run/../x", dir });
  assert.ok(!sink.runId.includes("/"), "the run id cannot name another directory");
  const passed = [];
  const lines = progressLines(tapColabProgress((event) => passed.push(event), sink));
  lines.write(`${line({ stage: "sampler", label: "KSampler #3", n: 3, total: 30 })}\n${line({ stage: "sampler", label: "KSampler #3", n: 15, total: 30, rate: 2.5, eta: 6 })}\n`);
  lines.write(`${JSON.stringify({ v: 1, job: "a.still", seq: 1, event: "progress", value: 0.42, at: "2026-10-20T19:00:01Z" })}\nplain text\n`);
  lines.end();
  assert.deepEqual(passed.map((event) => event.event), ["progress"]);
  const snap = readColabProgress({ dir, now: Date.now() });
  assert.equal(snap.runs.length, 1);
  const [run] = snap.runs;
  assert.equal(run.active, true);
  assert.equal(run.updates, 3);
  const sampler = run.gauges.find((gauge) => gauge.stage === "sampler");
  assert.deepEqual([sampler.n, sampler.total, sampler.rate, sampler.eta], [15, 30, 2.5, 6]);
  const job = run.gauges.find((gauge) => gauge.stage === "job");
  assert.deepEqual([job.label, job.n, job.total], ["a.still", 42, 100]);
});

test("a gauge record keeps only gauge fields, bounded", () => {
  const clean = cleanGauge({ event: "colab_progress", job: "j", stage: "tqdm", label: "x".repeat(500), n: 1, total: 2, secret: "nope", rate: "fast" });
  assert.equal(clean.secret, undefined);
  assert.equal(clean.rate, null);
  assert.equal(clean.label.length, 120);
});

test("old runs drop out of the snapshot and idle ones are not live", () => {
  const dir = scratch();
  createColabProgressSink({ runId: "old", dir }).write({ stage: "tqdm", label: "a", n: 1, total: 2 });
  assert.equal(readColabProgress({ dir, now: Date.now() + 13 * 3600_000 }).runs.length, 0);
  assert.equal(readColabProgress({ dir, now: Date.now() + 5 * 60_000 }).runs[0].active, false);
  assert.deepEqual(readColabProgress({ dir: join(dir, "missing") }).runs, []);
});

test("fake Google Colab run: the helper is uploaded and the batch's gauges land on the box", async () => {
  const dir = scratch();
  const progressDir = join(dir, "gauges");
  const jobsFile = join(dir, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify({ v: 1, hash: "a".repeat(64), packageId: "pkg_demo0001", jobs: [] }));
  const tokenPath = join(dir, "hf-token");
  writeFileSync(tokenPath, "hf_FAKETOKENVALUE0123456789ABCDEF\n", { mode: 0o600 });
  const manifest = { v: 1, run_id: "r", jobsHash: "a".repeat(64), packageId: "pkg_demo0001", complete: true, counts: {}, jobs: [] };
  const fake = installFakeColab(dir, {
    state: {
      usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
      sessions: "No active sessions found on server.\n",
      scripts: {
        "bootstrap.py": { output: "ok", files: [{ path: "/content/comfyrizz/out/ready.json", content: '{"ok":true}' }] },
        "health.py": { output: "ok", files: [{ path: "/content/comfyrizz/out/health.json", content: '{"ok":true}' }] },
        "run_jobs.py": {
          output: [
            line({ stage: "node", label: "nodes", n: 0, total: 9, state: "running" }),
            line({ stage: "sampler", label: "KSampler #3", n: 30, total: 30 }),
            line({ stage: "node", label: "nodes", n: 9, total: 9, state: "done" }),
          ].join("\n"),
          files: [{ path: "/content/comfyrizz/out/manifest.json", content: JSON.stringify(manifest) }],
        },
      },
    },
  });
  const backend = createColabBackend({
    cli: makeCli(fake), packageId: "pkg_demo0001", scratchDir: join(dir, "scratch"), logDir: join(fake.tmpDir, "logs"),
    packageDir: null, budgetUnits: 20, hfTokenPath: tokenPath, jobsFile, teardownRetryMs: 5, watchdogMinutes: 0.02, progressDir,
  });
  await backend.ensureUp({ approved: true });
  await backend.bootstrap();
  await backend.health();
  const events = [];
  await backend.run(jobsFile, (event) => events.push(event));
  await backend.teardown("done");
  const commands = readLog(fake.logPath).map((entry) => entry.argv.join(" "));
  const tapUpload = commands.findIndex((cmd) => cmd.startsWith("upload") && cmd.includes("/content/comfyrizz/progress_tap.py"));
  const runExec = commands.findIndex((cmd) => cmd.includes("-f run_jobs.py"));
  assert.ok(tapUpload >= 0 && tapUpload < runExec, commands.join("\n"));
  assert.equal(events.some((event) => event.event === "colab_progress"), false);
  const files = readdirSync(progressDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^comfyrizz-demo0001\.run\./);
  assert.equal(readFileSync(join(progressDir, files[0]), "utf8").trim().split("\n").length, 3);
  const [run] = readColabProgress({ dir: progressDir }).runs;
  const nodes = run.gauges.find((gauge) => gauge.stage === "node");
  assert.deepEqual([nodes.n, nodes.total, nodes.state], [9, 9, "done"]);
});
