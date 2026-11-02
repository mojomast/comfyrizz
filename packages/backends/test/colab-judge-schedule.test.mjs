// judge-workflow v3: batch scheduling with an off-machine judge. Fakes only (fake `colab`, fake
// clock, scripted gate); no Google Colab session or paid call. Timings are taken from the
// 2026-11-02 Clawpocalypse live2/live3 logs: bootstrap ~7 min, a stills batch ~20 s, one LTX plate
// ~50 s of GPU plus ~20 s exec overhead, a still review ~72 s, a clip review ~90 s, Chatterbox
// voiceover ~5 min, collect + stop ~2 min, billed at the reported 8.9 units/h.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createColabBackend, coalesceSubmissions } from "../src/colab-backend.mjs";
import { installFakeColab, makeCli } from "./helpers.mjs";

const REMOTE = "/content/comfyrizz";
const SHOTS = ["c1", "c2", "c3", "o1", "o2", "p1", "p2"];
const CHAINED = { c2: "c1", c3: "c2" };
const MIN = 60000;
const T = { bootstrap: 7 * MIN, stillsExec: 20000, execOverhead: 20000, plateGpu: 50000, stillReview: 72000, clipReview: 90000, narration: 5 * MIN, collectStop: 2 * MIN, rate: 8.9 };

test("coalesceSubmissions merges queued releases into one payload per batch kind", () => {
  const merged = coalesceSubmissions([
    { batch: "video", jobs: [{ id: "a" }] },
    { batch: "regen", jobs: [{ id: "s", seed: 1 }] },
    { batch: "video", jobs: [{ id: "b" }] },
    { batch: "regen", jobs: [{ id: "s", seed: 2 }] },
    { batch: "video", jobs: [] },
  ]);
  assert.deepEqual(merged.map((p) => [p.batch, p.jobs.map((j) => j.id)]), [["video", ["a", "b"]], ["regen", ["s"]]]);
  assert.equal(merged[1].jobs[0].seed, 2, "a later copy of a job replaces the earlier one");
});

function scenario(t) {
  const root = mkdtempSync(join(tmpdir(), "comfyrizz-v3-sched-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stills = SHOTS.map((s) => ({ id: `a_${s}_still.still`, kind: "still", batch: "stills", output: `assets/a_${s}_still.png` }));
  const plates = SHOTS.map((s) => ({ id: `a_${s}_plate.plate`, kind: "plate", batch: "plates", output: `out/intermediates/a_${s}_plate.plate.mp4`, deps: [`a_${s}_still.still`] }));
  const doc = { v: 1, hash: "b".repeat(64), packageId: "pkg_sched", batches: [{ name: "stills", jobs: stills.map((j) => j.id) }, { name: "plates", jobs: plates.map((j) => j.id) }], jobs: [...stills, ...plates] };
  const jobsFile = join(root, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify(doc));
  const manifest = { v: 1, run_id: "r", jobsHash: doc.hash, packageId: "pkg_sched", complete: true, counts: { succeeded: 14 }, jobs: [...stills, ...plates].map((j) => ({ job: j.id, status: "succeeded", outputs: [{ relative: j.output }] })) };
  const files = [{ path: `${REMOTE}/out/manifest.json`, content: JSON.stringify(manifest) }, ...[...stills, ...plates].map((j) => ({ path: `${REMOTE}/out/${j.output}`, content: j.id }))];
  const fake = installFakeColab(root, { state: { usage: "Current balance: 330.60 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n", scripts: { "run_jobs.py": { output: '{"v":1,"event":"batch_done","value":1}', files } } } });
  mkdirSync(join(root, "remote", "content", "comfyrizz"), { recursive: true });
  // Scaled real time (1 simulated minute = 500 ms) so the judge and the VM really overlap.
  const SCALE = 120, t0 = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SCALE));
  let offset = 1_000_000;
  const clockNow = () => offset + (Date.now() - t0) * SCALE;
  const log = [];
  let context = null;
  const reviewed = new Set();
  const plateFor = (s) => plates.find((p) => p.id === `a_${s}_plate.plate`);
  const gate = {
    async handle(event) {
      if (event.type === "preview_ready") {
        for (const entry of event.manifest?.jobs ?? []) {
          const s = /^a_(\w+)_still\.still$/.exec(entry.job)?.[1];
          if (!s || reviewed.has(s)) continue;
          reviewed.add(s);
          await sleep(T.stillReview);
          log.push({ at: clockNow(), what: `still_verdict ${s}` });
          if (!CHAINED[s]) await context.submitJobs({ batch: "video", jobs: [plateFor(s)] });
        }
      } else if (event.type === "video_collected") {
        const s = /^a_(\w+)_plate/.exec(event.jobId)?.[1];
        await sleep(T.clipReview);
        log.push({ at: clockNow(), what: `clip_verdict ${s}` });
        const next = Object.keys(CHAINED).find((k) => CHAINED[k] === s);
        if (next) await context.submitJobs({ batch: "video", jobs: [plateFor(next)] });
      }
    },
  };
  const cli = makeCli(fake);
  const original = cli.run.bind(cli);
  cli.run = async (args, opts = {}) => {
    if (args[0] === "exec" && String(args[args.indexOf("-f") + 1]).endsWith("run_jobs.py")) {
      const n = pendingBatch?.jobs ?? 0;
      await sleep(pendingBatch?.batch === "stills" ? T.stillsExec : T.execOverhead + T.plateGpu * n);
      log.push({ at: clockNow(), what: `batch ${pendingBatch?.batch} x${n}` });
    }
    return original(args, opts);
  };
  let pendingBatch = null;
  const backend = createColabBackend({
    cli, packageId: "pkg_sched", scratchDir: join(root, "scratch"), logDir: join(root, "logs"), packageDir: null,
    budgetUnits: 5.0, progressDir: null, watchdogMinutes: 0, teardownRetryMs: 1, collectionRetryMs: 1, now: clockNow,
    refWatch: async (ctx) => { context = ctx; return gate; },
    onJudgeIdle: async () => { log.push({ at: clockNow(), what: "narration_start" }); await sleep(T.narration); log.push({ at: clockNow(), what: "narration_done" }); },
  });
  backend.state.startedAtMs = clockNow();
  offset += T.bootstrap;
  const events = [];
  const run = () => backend.run(jobsFile, (event) => {
    events.push(event);
    if (event.type === "batch_start") pendingBatch = event;
  });
  return { run, events, log, startedAt: () => backend.state.startedAtMs, now: clockNow };
}

test("v3 scheduling: released plates go up together while the judge is still reviewing, chained shots follow, and the voiceover uses judge idle time", async (t) => {
  const ws = scenario(t);
  await ws.run();
  const batches = ws.events.filter((e) => e.type === "batch_start");
  const plateBatches = batches.filter((e) => e.batch === "plates");
  const plateJobs = plateBatches.reduce((n, e) => n + e.jobs, 0);
  assert.equal(plateJobs, 7, `all 7 clips render: ${JSON.stringify(ws.log.map((l) => `${((l.at - ws.startedAt()) / MIN).toFixed(1)}m ${l.what}`))} ${JSON.stringify(ws.events.filter((e) => e.type === "refused"))}`);
  assert.ok(plateBatches.length <= 4, `plates coalesce (old scheduler: 7 single-job batches), got ${plateBatches.map((b) => b.jobs)}`);
  assert.ok(plateBatches.some((b) => b.jobs >= 3), "the unchained plates released during still review share a batch");
  const order = ws.log.map((l) => l.what);
  const firstPlate = order.findIndex((w) => w.startsWith("batch plates"));
  const lastStill = order.findLastIndex((w) => w.startsWith("still_verdict"));
  assert.ok(firstPlate < lastStill, "the first plate renders before the judge has finished the stills");
  assert.ok(order.indexOf("clip_verdict c1") < order.findIndex((w, i) => w.startsWith("batch plates") && i > order.indexOf("clip_verdict c1")), "the chained c2 renders after c1's clip is judged");
  assert.ok(order.includes("narration_done"), "the voiceover ran inside the judge's idle window");
  assert.equal(ws.events.filter((e) => e.type === "refused").length, 0, "no batch refused at a 5-unit run budget (voiceover included)");
  const units = ((ws.now() - ws.startedAt()) + T.collectStop) / 3600000 * T.rate;
  t.diagnostic(`projected ${units.toFixed(2)} units for 7 clips + voiceover; timeline ${JSON.stringify(ws.log.map((l) => `${((l.at - ws.startedAt()) / MIN).toFixed(1)}m ${l.what}`))}`);
  assert.ok(units <= 5, `7 clips + voiceover fit in 5 units (got ${units.toFixed(2)})`);
});
