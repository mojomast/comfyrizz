// RW08-F2: lock test for the reference-watch held-job overlay path in the Google Colab backend.
// This is a lock test: the RW08 wiring is already on the base, so it is expected to be green on the
// base unless one of these cases exposes a real bug. Fakes only: a fake `colab` executable and a
// scripted refWatch gate; no Google Colab, network or paid call is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createColabBackend } from "../src/colab-backend.mjs";
import { installFakeColab, makeCli } from "./helpers.mjs";

const REMOTE = "/content/comfyrizz";
const PACKAGE_ID = "pkg_rw08_f2";

const STILLS = [
  { id: "s_intro.still", kind: "still", batch: "stills", output: "assets/s_intro.png" },
  { id: "s_outro.still", kind: "still", batch: "stills", output: "assets/s_outro.png" },
];
const VIDEOS = [
  { id: "v_intro.plate", kind: "plate", batch: "plates", output: "assets/v_intro.mp4" },
  { id: "v_outro.plate", kind: "plate", batch: "plates", output: "assets/v_outro.mp4" },
];

function jobsDoc() {
  return {
    v: 1,
    hash: "a".repeat(64),
    packageId: PACKAGE_ID,
    batches: [
      { name: "stills", jobs: STILLS.map((job) => job.id) },
      { name: "plates", jobs: VIDEOS.map((job) => job.id) },
    ],
    jobs: [...STILLS, ...VIDEOS],
  };
}

function zipJobsDoc(file) {
  const read = spawnSync(
    process.env.COMFYRIZZ_PYTHON || "python3",
    ["-c", "import sys, zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read('jobs.json').decode())", file],
    { encoding: "utf8" },
  );
  assert.equal(read.status, 0, read.stderr);
  return JSON.parse(read.stdout);
}

/** Record every jobs.zip and batch selector the backend uploads, and the ids each run submits. */
function instrument(cli) {
  const records = [];
  const original = cli.run.bind(cli);
  cli.run = async (args, opts = {}) => {
    if (args[0] === "upload" && String(args[4]).endsWith("/jobs.zip")) {
      records.push({ type: "bundle", doc: zipJobsDoc(args[3]) });
    } else if (args[0] === "upload" && String(args[4]).endsWith("/batch.txt")) {
      records.push({ type: "selector", name: readFileSync(args[3], "utf8").trim() });
    } else if (args[0] === "exec" && String(args[args.indexOf("-f") + 1]).endsWith("run_jobs.py")) {
      const selector = [...records].reverse().find((record) => record.type === "selector")?.name ?? null;
      const bundle = [...records].reverse().find((record) => record.type === "bundle")?.doc ?? null;
      const ids = bundle
        ? bundle.jobs.filter((job) => job.batch === selector).map((job) => job.id)
        : [];
      records.push({ type: "exec", selector, ids });
    }
    return original(args, opts);
  };
  return records;
}

function scriptedGate() {
  let context = null;
  const seen = { accepted: [], overridden: [] };
  const gate = {
    async handle() {},
    accept(job) {
      seen.accepted.push(job.id);
      context.submitJobs({ batch: job.batch, jobs: [job] });
    },
    override(job) {
      seen.overridden.push(job.id);
      context.submitJobs({ batch: job.batch, jobs: [job] });
    },
  };
  return {
    seen,
    gate,
    refWatch: async (watchContext) => {
      context = watchContext;
      return gate;
    },
  };
}

function scenario(t, { refWatch = null, onRunExec = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "comfyrizz-rw08-f2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const doc = jobsDoc();
  const jobsFile = join(root, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify(doc));
  const manifest = {
    v: 1,
    run_id: "run_rw08_f2",
    jobsHash: doc.hash,
    packageId: PACKAGE_ID,
    complete: true,
    counts: { succeeded: 0 },
    jobs: [],
  };
  const fake = installFakeColab(root, {
    state: {
      usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
      scripts: {
        "run_jobs.py": {
          output: '{"v":1,"event":"batch_done","value":1}',
          files: [{ path: `${REMOTE}/out/manifest.json`, content: JSON.stringify(manifest) }],
        },
      },
    },
  });
  // The real VM has this directory from the token/bootstrap step; these tests exercise run() only.
  mkdirSync(join(root, "remote", "content", "comfyrizz"), { recursive: true });
  const cli = makeCli(fake);
  const records = instrument(cli);
  const backend = createColabBackend({
    cli,
    packageId: PACKAGE_ID,
    scratchDir: join(root, "scratch"),
    logDir: join(root, "logs"),
    packageDir: null,
    budgetUnits: 100,
    progressDir: null,
    watchdogMinutes: 0,
    teardownRetryMs: 1,
    collectionRetryMs: 1,
    refWatch,
  });
  const events = [];
  const run = () => backend.run(jobsFile, (event) => {
    events.push(event);
    if (event.type === "run_exec") onRunExec?.(event);
  });
  return { doc, records, events, run };
}

const bundles = (records) => records.filter((record) => record.type === "bundle").map((record) => record.doc);
const execs = (records) => records.filter((record) => record.type === "exec");
const batchStarts = (events) => events.filter((event) => event.type === "batch_start").map((event) => ({
  batch: event.batch,
  jobs: event.jobs,
}));

test("reference watch holds every video batch and runs stills first", async (t) => {
  const gate = scriptedGate();
  const ws = scenario(t, { refWatch: gate.refWatch });

  await ws.run();

  const submitted = execs(ws.records);
  assert.equal(submitted.length, 1, "only the stills batch may run before any keyframe is accepted");
  assert.equal(submitted[0].selector, "stills");
  assert.deepEqual(submitted[0].ids, STILLS.map((job) => job.id));
  for (const video of VIDEOS) {
    assert.equal(submitted[0].ids.includes(video.id), false, `${video.id} must not be in the first batch`);
  }
  assert.deepEqual(batchStarts(ws.events), [{ batch: "stills", jobs: STILLS.length }]);

  const planned = bundles(ws.records);
  assert.equal(planned.length, 1, "no overlay bundle is uploaded while every held job is still held");
  assert.deepEqual(planned[0], ws.doc);
});

test("an accepted and an overridden keyframe release held videos in overlay batches", async (t) => {
  const gate = scriptedGate();
  const ws = scenario(t, {
    refWatch: gate.refWatch,
    onRunExec: (event) => {
      if (event.batch === "stills") gate.gate.accept(VIDEOS[0]);
      else if (event.batch === "plates" && gate.seen.accepted.length === 1 && gate.seen.overridden.length === 0) {
        gate.gate.override(VIDEOS[1]);
      }
    },
  });

  await ws.run();

  assert.deepEqual(gate.seen.accepted, [VIDEOS[0].id]);
  assert.deepEqual(gate.seen.overridden, [VIDEOS[1].id]);

  const submitted = execs(ws.records);
  assert.deepEqual(submitted.map((entry) => entry.selector), ["stills", "plates", "plates"]);
  assert.deepEqual(submitted[0].ids, STILLS.map((job) => job.id), "stills run first and alone");
  assert.deepEqual(submitted[1].ids, [VIDEOS[0].id], "only the accepted job is submitted first");
  assert.deepEqual(submitted[2].ids, [VIDEOS[1].id], "only the overridden job is submitted after it");

  const uploaded = bundles(ws.records);
  assert.equal(uploaded.length, 3, "the plan plus one overlay per released held job");
  assert.deepEqual(uploaded[0], ws.doc);
  assert.deepEqual(uploaded[1].batches, [{ name: "plates", jobs: [VIDEOS[0].id] }]);
  assert.equal(uploaded[1].jobs.find((job) => job.id === VIDEOS[1].id).batch, "audio", "the still-held video is parked off the planned batches");
  assert.deepEqual(uploaded[2].batches, [{ name: "plates", jobs: [VIDEOS[1].id] }]);
  assert.equal(uploaded[2].jobs.find((job) => job.id === VIDEOS[0].id).batch, "audio");
});

test("without a reference watch the planned batches and their bundle are unchanged", async (t) => {
  const ws = scenario(t);

  await ws.run();

  const submitted = execs(ws.records);
  assert.deepEqual(submitted.map((entry) => entry.selector), ["stills", "plates"]);
  assert.deepEqual(submitted[0].ids, STILLS.map((job) => job.id));
  assert.deepEqual(submitted[1].ids, VIDEOS.map((job) => job.id));
  assert.deepEqual(batchStarts(ws.events), [
    { batch: "stills", jobs: STILLS.length },
    { batch: "plates", jobs: VIDEOS.length },
  ]);

  const uploaded = bundles(ws.records);
  assert.equal(uploaded.length, 1, "the second planned batch reuses the plan bundle");
  assert.deepEqual(uploaded[0], ws.doc);
});
