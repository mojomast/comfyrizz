// SPW04: a collected video releases the next deferred chained shot in the same Google Colab session.
//
// Fakes only: a fake `colab` executable and a scripted reference-watch gate. No Google Colab session,
// no compute units, no network and no paid model call is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createColabBackend } from "../src/colab-backend.mjs";
import { installFakeColab, makeCli } from "./helpers.mjs";

const REMOTE = "/content/comfyrizz";
const PACKAGE_ID = "pkg_spw04_chain";

const STILLS = [
  { id: "s_intro.still", kind: "still", batch: "stills", output: "assets/s_intro.png" },
];
const VIDEOS = [
  { id: "v_intro.plate", kind: "plate", batch: "plates", output: "assets/v_intro.mp4" },
  { id: "v_outro.plate", kind: "plate", batch: "plates", output: "assets/v_outro.mp4" },
];

const contentFor = (job) => `SPW04-CONTENT:${job.id}`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function jobsDoc() {
  return {
    v: 1,
    hash: "b".repeat(64),
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

function manifestFor(doc, jobs) {
  return {
    v: 1,
    run_id: "run_spw04_chain",
    jobsHash: doc.hash,
    packageId: PACKAGE_ID,
    complete: true,
    counts: { succeeded: jobs.length },
    jobs: jobs.map((job) => {
      const content = contentFor(job);
      return {
        job: job.id,
        status: "succeeded",
        outputs: [{ relative: job.output, bytes: Buffer.byteLength(content), sha256: sha256(content) }],
      };
    }),
  };
}

function batchSpec(doc, jobs) {
  return {
    output: JSON.stringify({ v: 1, event: "batch_done", value: jobs.length }),
    files: [
      { path: `${REMOTE}/out/manifest.json`, content: JSON.stringify(manifestFor(doc, jobs)) },
      ...jobs.map((job) => ({ path: `${REMOTE}/out/${job.output}`, content: contentFor(job) })),
    ],
  };
}

/** Queue video A up front; when A is collected, queue the deferred chained video B. */
function chainedGate() {
  let context = null;
  const seen = { collected: [], order: [], pathExistedWhenQueued: null };
  const gate = {
    async handle(event) {
      if (event.type !== "video_collected") return;
      seen.collected.push(event);
      seen.order.push(`video_collected:${event.jobId}`);
      if (event.jobId === VIDEOS[0].id) {
        seen.pathExistedWhenQueued = existsSync(event.path);
        seen.order.push(`queue:${VIDEOS[1].id}`);
        context.submitJobs({ batch: VIDEOS[1].batch, jobs: [VIDEOS[1]] });
      }
    },
  };
  return {
    seen,
    gate,
    refWatch: async (watchContext) => {
      context = watchContext;
      watchContext.submitJobs({ batch: VIDEOS[0].batch, jobs: [VIDEOS[0]] });
      return gate;
    },
  };
}

function scenario(t, { refWatch = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "comfyrizz-spw04-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const doc = jobsDoc();
  const jobsFile = join(root, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify(doc));
  const fake = installFakeColab(root, {
    state: {
      usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
      scripts: {
        "run_jobs.py": [
          batchSpec(doc, STILLS),
          batchSpec(doc, [VIDEOS[0]]),
          batchSpec(doc, [VIDEOS[1]]),
        ],
      },
    },
  });
  // The real VM has this directory from the token/bootstrap step; this test exercises run() only.
  mkdirSync(join(root, "remote", "content", "comfyrizz"), { recursive: true });
  const cli = makeCli(fake);
  const records = instrument(cli);
  const scratch = join(root, "scratch");
  const backend = createColabBackend({
    cli,
    packageId: PACKAGE_ID,
    scratchDir: scratch,
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
  const run = () => backend.run(jobsFile, (event) => events.push(event));
  return { doc, records, events, run, scratch };
}

const execs = (records) => records.filter((record) => record.type === "exec");

test("a collected video releases the next chained shot in the same session", async (t) => {
  const gate = chainedGate();
  const ws = scenario(t, { refWatch: gate.refWatch });

  await ws.run();

  assert.deepEqual(
    gate.seen.collected.map((event) => event.jobId),
    [VIDEOS[0].id, VIDEOS[1].id],
    "video_collected must be emitted for every collected video job",
  );
  assert.equal(gate.seen.pathExistedWhenQueued, true, "video A's local path must exist before B is queued");
  for (const event of gate.seen.collected) {
    assert.equal(isAbsolute(event.path), true, `${event.jobId} path must be absolute: ${event.path}`);
    assert.equal(existsSync(event.path), true, `${event.jobId} path must exist: ${event.path}`);
    assert.equal(
      resolve(event.path).startsWith(`${resolve(ws.scratch, "out")}/`),
      true,
      `${event.jobId} path must be inside the scratch collect dir: ${event.path}`,
    );
  }
  assert.deepEqual(
    gate.seen.order,
    [`video_collected:${VIDEOS[0].id}`, `queue:${VIDEOS[1].id}`, `video_collected:${VIDEOS[1].id}`],
    "B is queued only after A is collected",
  );

  const submitted = execs(ws.records);
  assert.deepEqual(submitted.map((entry) => entry.selector), ["stills", "plates", "plates"]);
  assert.deepEqual(submitted[0].ids, STILLS.map((job) => job.id), "stills run first");
  assert.deepEqual(submitted[1].ids, [VIDEOS[0].id], "the first released video runs alone");
  assert.deepEqual(submitted[2].ids, [VIDEOS[1].id], "the chained video runs after A was collected");
});
