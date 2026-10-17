// B2 acceptance: planner unit tests - batch ordering (every still before any plate),
// LTX dimensions on the kind's lattice (64 for plates, N9), frames 8n+1, deterministic hashing,
// cache keys, cutout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planJobs,
  checkJobsDoc,
  cacheKeyFor,
  canonical,
  sha256Hex,
  BATCH_ORDER,
  resolveDimension,
  resolveDimensions,
  resolveFrames,
  resolveFramesFromSeconds,
  isDimensionValid,
  isFrameCountValid,
} from "../src/index.mjs";
import { validatePackage } from "../../schema/src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel) => JSON.parse(readFileSync(join(here, "fixtures", rel), "utf8"));
const schemaFixture = (rel) =>
  JSON.parse(readFileSync(join(here, "..", "..", "schema", "fixtures", rel), "utf8"));

test("the planner fixture is a valid comfyrizz.package/v1 document", () => {
  const result = validatePackage(fixture("package-pending.json"));
  assert.deepEqual(result.errors, []);
});

test("dimensions resolve to the required multiple", () => {
  assert.equal(resolveDimension(961), 960);
  assert.equal(resolveDimension(545), 544);
  assert.equal(resolveDimension(1000), 992);
  assert.equal(resolveDimension(16), 32, "never below one multiple");
  assert.equal(resolveDimension(1024), 1024);
  assert.deepEqual(resolveDimensions(961, 545), {
    width: 960,
    height: 544,
    adjusted: true,
    requested: { width: 961, height: 545 },
  });
  assert.equal(resolveDimensions(960, 544).adjusted, false);
  assert.ok(isDimensionValid(960, 32) && isDimensionValid(992, 32));
  assert.ok(!isDimensionValid(961, 32) && !isDimensionValid(16, 32));
});

test("a plate is planned on the 64 lattice so its stage 1 stays on the 32 lattice (GPU test 3, N9)", () => {
  // 960x544 went in and 960x512 came out: half of 544 is 272, and LTX floors a latent to 32, so a
  // final size that is only a multiple of 32 cannot survive the two-stage graph unchanged.
  const doc = planJobs(fixture("package-pending.json"));
  const plate = doc.jobs.find((job) => job.id === "a_plate1.plate");
  assert.ok(plate, "the fixture plans a plate");
  // the fixture asks 960x544 for the plate and 961x545 for its first frame: both land on 960x576, so
  // the pair agrees without the package having to state two sizes that match
  assert.deepEqual(plate.dims, { width: 960, height: 576 }, "544 ties up to 576 on the 64 lattice");
  assert.deepEqual(doc.jobs.find((job) => job.id === "a_plate1_still.still").dims, { width: 960, height: 576 });
  for (const job of doc.jobs) {
    if (job.kind !== "plate") continue;
    assert.equal(job.dims.width % 64, 0, `${job.id} dims ${JSON.stringify(job.dims)}`);
    assert.equal(job.dims.height % 64, 0, `${job.id} dims ${JSON.stringify(job.dims)}`);
    assert.equal(job.stage1Dims.width % 32, 0, `${job.id}: what the graph's node 8 takes`);
    assert.equal(job.stage1Dims.height % 32, 0, `${job.id}: what the graph's node 8 takes`);
    assert.deepEqual(job.stage1Dims, { width: job.dims.width / 2, height: job.dims.height / 2 });
  }
  // an upscale's own dims are the package's frame (1920x1080) after the x2 crop, so it is not the
  // plate lattice that decides them - but its stage 1 is still half of that frame
  const upscale = doc.jobs.find((job) => job.id === "a_plate1.upscale");
  assert.deepEqual(upscale.stage1Dims, { width: upscale.dims.width / 2, height: upscale.dims.height / 2 });

  // a plate that asks for no size gets the 64-multiple default, in 16:9 rather than the old 960x544
  const bare = fixture("package-pending.json");
  delete bare.assets.a_plate1.gen.inputs.width;
  delete bare.assets.a_plate1.gen.inputs.height;
  bare.assets.a_plate1_still.gen.inputs.width = 1024;
  bare.assets.a_plate1_still.gen.inputs.height = 576;
  const barePlate = planJobs(bare).jobs.find((job) => job.id === "a_plate1.plate");
  assert.deepEqual(barePlate.dims, { width: 1024, height: 576 });
  assert.deepEqual(barePlate.stage1Dims, { width: 512, height: 288 });
  assert.equal(barePlate.dimsAdjusted, false);

  // a first frame that asks for a different shape than its plate is still refused, naming the plate
  const square = fixture("package-pending.json");
  square.assets.a_plate1_still.gen.inputs.width = 960;
  square.assets.a_plate1_still.gen.inputs.height = 960;
  assert.throws(() => planJobs(square), /renders at 960x576 \(aspect 1\.667\)/);
});

test("frame counts resolve to 8n+1 (nearest, ties up)", () => {
  const table = [
    [97, 97],
    [100, 97],
    [101, 105],
    [1, 1],
    [9, 9],
    [8, 9],
    [12, 9],
    [13, 17],
    [120, 121],
    [121, 121],
    [104, 105],
    [96, 97],
    [4, 1],
  ];
  for (const [requested, expected] of table) {
    assert.equal(resolveFrames(requested), expected, `resolveFrames(${requested})`);
    assert.ok(isFrameCountValid(expected));
  }
  assert.throws(() => resolveFrames(0), RangeError);
  assert.throws(() => resolveFrames(-5), RangeError);
  assert.equal(resolveFramesFromSeconds(4.0, 24), 97, "4.0 s at 24 fps is the documented 97-frame plate");
  assert.equal(resolveFramesFromSeconds(5.0, 24), 121);
});

test("all FLUX stills are batched before any plate, then upscales, then audio", () => {
  const doc = planJobs(fixture("package-pending.json"));
  assert.deepEqual(
    doc.batches.map((b) => b.name),
    ["stills", "plates", "upscales", "audio"],
  );
  const order = doc.jobs.map((job) => job.batch);
  const firstPlate = order.indexOf("plates");
  const lastStill = order.lastIndexOf("stills");
  assert.ok(lastStill < firstPlate, `stills must all precede plates (got ${order.join(",")})`);
  assert.deepEqual(
    doc.jobs.filter((j) => j.kind === "still").map((j) => j.asset),
    ["a_cutout", "a_plate1_still"],
  );
  assert.equal(BATCH_ORDER.join(","), "stills,plates,upscales,audio");
});

test("the plate depends on its still and the upscale depends on the plate and its start image", () => {
  const doc = planJobs(fixture("package-pending.json"));
  const byId = Object.fromEntries(doc.jobs.map((j) => [j.id, j]));
  assert.deepEqual(byId["a_plate1.plate"].deps, ["a_plate1_still.still"]);
  // the finals pass reuses the plate's graph, so it needs the same uploaded start image and
  // names its producer as well as the plate itself
  assert.deepEqual(byId["a_plate1.upscale"].deps, ["a_plate1.plate", "a_plate1_still.still"]);
  assert.equal(byId["a_plate1.upscale"].source, "out/intermediates/a_plate1.plate.mp4");
  assert.equal(byId["a_plate1.plate"].output, "out/intermediates/a_plate1.plate.mp4");
  assert.equal(byId["a_plate1.upscale"].output, "assets/a_plate1.mp4");
  assert.equal(byId["a_narr.audio"].output, "assets/a_narr.wav");
});

test("an image parameter becomes an upload instruction, not an asset id", () => {
  const doc = planJobs(fixture("package-pending.json"));
  const byId = Object.fromEntries(doc.jobs.map((j) => [j.id, j]));
  // from: job - the i2v plate starts from the still this same plan generates
  assert.deepEqual(byId["a_plate1.plate"].fileInputs, [
    { param: "image", from: "job", job: "a_plate1_still.still", path: "assets/a_plate1_still.png" },
  ]);
  assert.deepEqual(byId["a_plate1.upscale"].fileInputs, byId["a_plate1.plate"].fileInputs);
  // a still with no image/reference parameter carries none, so nothing is uploaded for it
  assert.equal(byId["a_plate1_still.still"].fileInputs, undefined);
  assert.equal(byId["a_narr.audio"].fileInputs, undefined);
});

test("a reference parameter resolves to the generated still too", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_plate1_still.status = "pending";
  pkg.assets.a_ref = {
    kind: "image",
    origin: "generated",
    status: "pending",
    license: { id: "CC0-1.0" },
    model_license: { id: "flux-3-image-klein-nc" },
    gen: {
      generator: "flux3-klein",
      workflow: "workflows/flux3_klein_ref_edit.api.json",
      workflow_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      model: "flux-3-image-klein",
      inputs: { reference: "a_plate1_still", prompt: "keep the layout, restyle it", seed: 9, steps: 16, megapixels: 1 },
    },
  };
  const byId = Object.fromEntries(planJobs(pkg).jobs.map((j) => [j.id, j]));
  assert.deepEqual(byId["a_ref.still"].fileInputs, [
    { param: "reference", from: "job", job: "a_plate1_still.still", path: "assets/a_plate1_still.png" },
  ]);
  assert.deepEqual(byId["a_ref.still"].deps, ["a_plate1_still.still"]);
});

test("a file parameter that is neither an asset nor a path is refused, naming it", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_plate1.gen.inputs.image = "the fox picture";
  assert.throws(() => planJobs(pkg), /neither.*asset|not an asset in this package/s);
  assert.throws(() => planJobs(pkg), /a_plate1/);
});

test("a file parameter pointing at an asset with no job and no file is refused", () => {
  const pkg = fixture("package-pending.json");
  delete pkg.assets.a_plate1_still.status; // still pending: it has a job, so planning is fine
  pkg.assets.a_stock = { kind: "image", origin: "stock", status: "ready", file: "assets/a_stock.jpg", license: { id: "CC-BY-4.0" }, sha256: "a".repeat(64) };
  pkg.assets.a_plate1.gen.inputs.image = "a_stock";
  const job = planJobs(pkg).jobs.find((j) => j.id === "a_plate1.plate");
  assert.deepEqual(job.fileInputs, [{ param: "image", from: "package", path: "assets/a_stock.jpg" }]);

  const broken = fixture("package-pending.json");
  broken.assets.a_stock = { kind: "image", origin: "stock", status: "candidate", license: { id: "CC-BY-4.0" } };
  broken.assets.a_plate1.gen.inputs.image = "a_stock";
  assert.throws(() => planJobs(broken), /carries no\s+`file`/s);
});

test("checkJobsDoc catches a malformed file input", () => {
  const doc = planJobs(fixture("package-pending.json"));
  assert.deepEqual(checkJobsDoc(doc), []);
  const broken = JSON.parse(JSON.stringify(doc));
  const plate = broken.jobs.find((j) => j.id === "a_plate1.plate");
  plate.fileInputs[0].from = "cloud";
  plate.fileInputs.push({ param: "image", from: "package", path: "/etc/passwd" });
  plate.fileInputs.push({ param: "shrug", from: "package", path: "assets/whatever.png" });
  plate.fileInputs.push({ param: "image", from: "job", job: "a_ghost.still", path: "assets/a_ghost.png" });
  const problems = checkJobsDoc(broken);
  assert.ok(problems.some((p) => /from "cloud" must be job or package/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /fileInputs image path absolute path/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /fileInputs param "shrug"/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /produced by a_ghost.still, which is not in this document/.test(p)), problems.join("\n"));
});

test("plate jobs record the stage-1 lattice the two-stage graph actually renders", () => {
  const doc = planJobs(fixture("package-pending.json"));
  const byId = Object.fromEntries(doc.jobs.map((j) => [j.id, j]));
  const plate = byId["a_plate1.plate"];
  // dims is the finished frame; stage 1 is half of it, which the x2 latent upsampler doubles back
  assert.deepEqual(plate.dims, { width: 960, height: 576 });
  assert.deepEqual(plate.stage1Dims, { width: 480, height: 288 });
  assert.deepEqual(byId["a_plate1.upscale"].stage1Dims, { width: 960, height: 540 }, "half of the 1920x1080 finals frame");
  assert.equal(byId["a_plate1_still.still"].stage1Dims, undefined, "a still is one pass, no lattice");
  assert.deepEqual(checkJobsDoc(doc), []);

  const broken = JSON.parse(JSON.stringify(doc));
  broken.jobs.find((j) => j.id === "a_plate1.plate").stage1Dims = { width: 480, height: 272 };
  assert.ok(checkJobsDoc(broken).some((p) => /stage1Dims 480x272 is not half of dims 960x576/.test(p)));
});

test("an i2v source at a different aspect than its plate is refused, naming both", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_plate1_still.gen.inputs.width = 1024;
  pkg.assets.a_plate1_still.gen.inputs.height = 1024;
  assert.throws(() => planJobs(pkg), /first frame a_plate1_still is planned at 1024x1024 \(aspect 1\.000\) but this plate renders at 960x576/);
  assert.throws(() => planJobs(pkg), /generate it at the plate's aspect/);

  // a source within 1% of the plate's aspect is rounding noise, not a different shape (and a source
  // like this one rounds onto the plate's own lattice, N9)
  const close = fixture("package-pending.json");
  close.assets.a_plate1_still.gen.inputs.width = 960;
  close.assets.a_plate1_still.gen.inputs.height = 570;
  assert.deepEqual(planJobs(close).warnings, []);

  // and a caller who really wants the centre-crop can say so: the plan then records it
  const allowed = planJobs(pkg, { allowAspectMismatch: true });
  assert.deepEqual(allowed.warnings.map((w) => w.code), ["PLAN_SOURCE_ASPECT_MISMATCH"]);
  assert.match(allowed.warnings[0].message, /allowed by the caller/);
  assert.deepEqual(checkJobsDoc(allowed), []);
});

test("a t2v plate with no source still is not aspect-checked", () => {
  const pkg = fixture("package-pending.json");
  delete pkg.assets.a_plate1.gen.inputs.image;
  const doc = planJobs(pkg);
  const plate = doc.jobs.find((j) => j.id === "a_plate1.plate");
  assert.equal(plate.inputAsset, null);
  assert.deepEqual(plate.fileInputs, undefined);
  assert.deepEqual(doc.warnings, []);
});

test("jobs carry resolved dimensions, frames, crop and the cache key", () => {
  const doc = planJobs(fixture("package-pending.json"));
  const byId = Object.fromEntries(doc.jobs.map((j) => [j.id, j]));
  const plate = byId["a_plate1.plate"];
  assert.deepEqual(plate.dims, { width: 960, height: 576 }, "960x544 on the plate's 64 lattice (N9)");
  assert.equal(plate.frames, 97, "100 requested frames resolve to 97");
  assert.equal(plate.framesAdjusted, true);
  assert.equal(plate.fps, 24);
  const up = byId["a_plate1.upscale"];
  assert.deepEqual(up.upscaleTarget, { width: 1920, height: 1152 }, "x2 of the 960x576 plate");
  assert.deepEqual(up.dims, { width: 1920, height: 1080 }, "x2 then crop to the package format");
  assert.deepEqual(up.crop, { top: 36, bottom: 36, left: 0, right: 0 });
  const still = byId["a_plate1_still.still"];
  assert.deepEqual(still.dims, { width: 960, height: 576 }, "a plate's first frame follows the plate's lattice (N9)");
  for (const job of doc.jobs) {
    assert.match(job.cacheKey, /^[a-f0-9]{64}$/);
  }
});

test("cutout is carried into the still job that asks for it", () => {
  const doc = planJobs(fixture("package-pending.json"));
  const byId = Object.fromEntries(doc.jobs.map((j) => [j.id, j]));
  assert.equal(byId["a_cutout.still"].cutout, true);
  assert.equal(byId["a_cutout.still"].params.cutout, true);
  assert.equal(byId["a_plate1_still.still"].cutout, undefined);
  assert.equal(byId["a_plate1_still.still"].params.cutout, false);
});

test("llm-svg assets are not Comfy jobs, and ready assets need no job", () => {
  const doc = planJobs(fixture("package-pending.json"));
  assert.ok(doc.skipped.some((s) => s.asset === "a_logo" && /llm-svg/.test(s.reason)));
  assert.ok(!doc.jobs.some((j) => j.asset === "a_logo"));

  const ready = schemaFixture("valid/spec-6.3-example.json");
  assert.deepEqual(planJobs(ready).jobs, [], "everything is ready: nothing to generate");
  const forced = planJobs(ready, { includeReady: true });
  assert.ok(forced.jobs.length >= 2);
  assert.ok(forced.jobs.some((j) => j.kind === "plate"));
});

test("planning is deterministic and hash-sensitive", () => {
  const pkg = fixture("package-pending.json");
  const a = planJobs(pkg);
  const b = planJobs(pkg);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a, b);
  assert.equal(a.hash, sha256Hex(canonical({ ...a, hash: undefined })));
  assert.match(a.hash, /^[a-f0-9]{64}$/);

  const changed = JSON.parse(JSON.stringify(pkg));
  changed.assets.a_plate1.gen.inputs.seed = 43;
  const c = planJobs(changed);
  assert.notEqual(a.hash, c.hash);
  const plateBefore = a.jobs.find((j) => j.id === "a_plate1.plate");
  const plateAfter = c.jobs.find((j) => j.id === "a_plate1.plate");
  assert.notEqual(plateBefore.cacheKey, plateAfter.cacheKey, "seed is part of the cache key");

  const other = JSON.parse(JSON.stringify(pkg));
  other.assets.a_plate1.gen.workflow_sha256 = "f".repeat(64);
  assert.notEqual(planJobs(other).hash, a.hash, "the workflow hash is part of the plan");
});

test("the same cache key ignores input key order but not values", () => {
  const base = { workflowSha256: "a".repeat(64), generator: "ltx25", model: "m", modelRevision: "r", params: { width: 960, height: 544 }, seed: 42, width: 960, height: 544, frames: 97 };
  const reordered = { ...base, params: { height: 544, width: 960 } };
  assert.equal(cacheKeyFor(base), cacheKeyFor(reordered));
  assert.notEqual(cacheKeyFor(base), cacheKeyFor({ ...base, frames: 121 }));
  assert.notEqual(cacheKeyFor(base), cacheKeyFor({ ...base, modelRevision: "r2" }));
});

test("checkJobsDoc accepts a planned document and names real problems", () => {
  const doc = planJobs(fixture("package-pending.json"));
  assert.deepEqual(checkJobsDoc(doc), []);

  const broken = JSON.parse(JSON.stringify(doc));
  broken.jobs[0].output = "/etc/passwd";
  broken.jobs[1].batch = "shrug";
  broken.jobs[2].cacheKey = "nope";
  broken.jobs.push({ ...broken.jobs[0] });
  const problems = checkJobsDoc(broken);
  assert.ok(problems.some((p) => /output path absolute path/.test(p)));
  assert.ok(problems.some((p) => /batch "shrug"/.test(p)));
  assert.ok(problems.some((p) => /cacheKey must be a sha256/.test(p)));
  assert.ok(problems.some((p) => /duplicate job id/.test(p)));
});

test("an absolute or traversing workflow path is refused, naming the path", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_cutout.gen.workflow = "/opt/workflows/flux.json";
  assert.throws(() => planJobs(pkg), /absolute path/);
  const pkg2 = fixture("package-pending.json");
  pkg2.assets.a_cutout.gen.workflow = "../outside/flux.json";
  assert.throws(() => planJobs(pkg2), /parent-directory traversal/);
});

test("a missing workflow hash is refused rather than silently uncached", () => {
  const pkg = fixture("package-pending.json");
  delete pkg.assets.a_cutout.gen.workflow_sha256;
  assert.throws(() => planJobs(pkg), /workflow_sha256 is required/);
});

test("the CLI plans and re-checks a jobs.json", () => {
  const cli = join(here, "..", "bin", "plan-jobs.mjs");
  const out = join(tmpdir(), `comfyrizz-jobs-${process.pid}.json`);
  const run = spawnSync(process.execPath, [cli, join(here, "fixtures", "package-pending.json"), "--out", out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const check = spawnSync(process.execPath, [cli, join(here, "fixtures", "package-pending.json"), "--out", out, "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
  assert.match(check.stdout, /jobs\.json is current/);
});

// --- prompt defaults (H-fix4): GPU test 2, docs/GPU_TEST_2.md "What looked bad" ---------------

test("a still prompt gets the no-text guard, and the job records what was appended", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_cutout.gen.inputs.prompt = "a small robot holding a film clapper, plain flat background";
  const still = planJobs(pkg).jobs.find((j) => j.id === "a_cutout.still");
  assert.match(still.params.prompt, /plain flat background, no text, no letters, no words, no logos, no watermarks$/);
  assert.deepEqual(still.promptGuards.map((g) => g.guard), ["text"]);
  assert.match(still.promptGuards[0].because, /GPU test 2/);
  // no prompt at all stays no prompt: the guard is not a prompt in itself
  const bare = planJobs(fixture("package-pending.json")).jobs.find((j) => j.id === "a_cutout.still");
  assert.equal(bare.params.prompt, undefined);
  assert.equal(bare.promptGuards, undefined);
});

test("an asset that asked for text keeps its prompt verbatim", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_cutout.gen.inputs.text = true;
  pkg.assets.a_cutout.gen.inputs.prompt = "a diagram with the label Solar Panel";
  const still = planJobs(pkg).jobs.find((j) => j.id === "a_cutout.still");
  assert.equal(still.params.prompt, "a diagram with the label Solar Panel");
  assert.equal(still.promptGuards, undefined);
});

test("the text flag stays on the job, not in params, where the runner would refuse it (GPU test 3, N1)", () => {
  // The repro was `gen.inputs.text = true`: the flag reached jobs[].params, and the runner failed the
  // job before submitting it ("no params.json mapping for text"). Either spelling is planner-only.
  const pkg = fixture("package-pending.json");
  pkg.assets.a_cutout.gen.inputs.text = true;
  pkg.assets.a_cutout.gen.inputs.allowText = true;
  pkg.assets.a_cutout.gen.inputs.prompt = "a diagram with the label Solar Panel";
  const doc = planJobs(pkg);
  const still = doc.jobs.find((j) => j.id === "a_cutout.still");
  assert.equal(still.params.text, undefined, "`text` is not a node input");
  assert.equal(still.params.allowText, undefined, "`allowText` is not a node input");
  assert.equal(still.allowText, true, "the decision is recorded on the job");
  for (const job of doc.jobs) {
    assert.ok(!("text" in job.params) && !("allowText" in job.params), `${job.id} carries a planner flag in params`);
  }
  // and the guards it steers are unchanged by the move: text allowed -> prompt verbatim, no guard
  assert.equal(still.params.prompt, "a diagram with the label Solar Panel");
  assert.equal(still.promptGuards, undefined);
  // a job that did not ask for text does not get the flag
  const plain = planJobs(fixture("package-pending.json")).jobs.find((j) => j.id === "a_cutout.still");
  assert.equal(plain.allowText, undefined);
});

test("a prompt that already refuses text is not given a second negative", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_cutout.gen.inputs.prompt = "a quiet nebula, no text, no letters";
  const still = planJobs(pkg).jobs.find((j) => j.id === "a_cutout.still");
  assert.equal(still.params.prompt, "a quiet nebula, no text, no letters");
  assert.equal(still.promptGuards, undefined);
});

test("a plate gets the motion guard for its flavour, and keeps its own camera direction", () => {
  const i2v = planJobs(fixture("package-pending.json")).jobs.find((j) => j.id === "a_plate1.plate");
  assert.match(i2v.params.prompt, /static camera, gentle motion, no cuts$/);
  assert.deepEqual(i2v.promptGuards.map((g) => g.guard).sort(), ["motion_i2v", "text"]);
  const upscale = planJobs(fixture("package-pending.json")).jobs.find((j) => j.id === "a_plate1.upscale");
  assert.deepEqual(upscale.promptGuards, i2v.promptGuards, "the finals pass inherits the plate's guards");

  const t2vPkg = fixture("package-pending.json");
  delete t2vPkg.assets.a_plate1.gen.inputs.image;
  const t2v = planJobs(t2vPkg).jobs.find((j) => j.id === "a_plate1.plate");
  assert.match(t2v.params.prompt, /slow continuous motion, static camera, seamless, no cuts$/);

  const own = fixture("package-pending.json");
  own.assets.a_plate1.gen.inputs.prompt = "the camera slowly pans right across the corridor";
  const kept = planJobs(own).jobs.find((j) => j.id === "a_plate1.plate");
  assert.equal(kept.params.prompt, `the camera slowly pans right across the corridor, ${"no text, no letters, no words, no logos, no watermarks"}`);
  assert.deepEqual(kept.promptGuards.map((g) => g.guard), ["text"], "a prompt with its own camera direction gets no motion guard");
});

test("LTX's measured weak spots are warnings, not silent rewrites", () => {
  const orbit = fixture("package-pending.json");
  orbit.assets.a_plate1.gen.inputs.prompt = "a slow orbit around the battery";
  assert.deepEqual(planJobs(orbit).warnings.map((w) => w.code), ["PLAN_ORBIT_UNRELIABLE"]);
  assert.match(planJobs(orbit).warnings[0].message, /does not reliably orbit/);

  // a labelled first frame plus a moving camera is the combination that pushed labels out of frame
  const labels = fixture("package-pending.json");
  labels.assets.a_plate1_still.gen.inputs.text = true;
  labels.assets.a_plate1.gen.inputs.prompt = "a gentle push in on the diagram";
  const codes = planJobs(labels).warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ["PLAN_CAMERA_ON_TEXT_FRAME", "PLAN_PUSH_IN_LABELS"]);
  assert.deepEqual(checkJobsDoc(planJobs(labels)), [], "warnings stay schema-valid");
});

test("stills resolve to the Klein 16 px lattice, and plates and their first frames to 64 (N9)", () => {
  const pkg = fixture("package-pending.json");
  // The GPU test 2 example (a 960x540 sample raster becomes 960x544) needs a still nobody consumes:
  // a still that IS a plate's first frame is planned on the plate's lattice instead (N9).
  pkg.assets.a_cutout.gen.inputs.width = 960;
  pkg.assets.a_cutout.gen.inputs.height = 540;
  const doc = planJobs(pkg);
  for (const job of doc.jobs.filter((j) => j.kind === "still")) {
    assert.equal(job.dims.width % 16, 0, `${job.id} width`);
    assert.equal(job.dims.height % 16, 0, `${job.id} height`);
  }
  const cutout = doc.jobs.find((j) => j.id === "a_cutout.still");
  assert.deepEqual(cutout.dims, { width: 960, height: 544 });
  // and the still's own params carry the resolved lattice, not the requested number
  assert.deepEqual([cutout.params.width, cutout.params.height], [960, 544]);
  // the plate's first frame is on the plate's lattice, which is why the fixture's 961x545 still and
  // its 960x544 plate both come out 960x576
  const source = doc.jobs.find((j) => j.id === "a_plate1_still.still");
  assert.deepEqual(source.dims, { width: 960, height: 576 });
  for (const job of doc.jobs.filter((j) => j.kind === "plate")) {
    assert.equal(job.dims.width % 64, 0, `${job.id} width`);
    assert.equal(job.dims.height % 64, 0, `${job.id} height`);
  }
  // an upscale ends on the package's own frame (1920x1080 after the x2 crop), so it is not on the
  // 64 lattice by design - its stage-1 lattice is, and the plan states both
  const upscale = doc.jobs.find((j) => j.id === "a_plate1.upscale");
  assert.deepEqual(upscale.dims, { width: 1920, height: 1080 });
  assert.deepEqual(upscale.crop, { top: 36, bottom: 36, left: 0, right: 0 });
});
