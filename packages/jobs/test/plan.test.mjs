// B2 acceptance: planner unit tests - batch ordering (every still before any plate),
// LTX dimensions x32, frames 8n+1, deterministic hashing, cache keys, cutout.
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
  assert.deepEqual(plate.dims, { width: 960, height: 544 });
  assert.deepEqual(plate.stage1Dims, { width: 480, height: 272 });
  assert.deepEqual(byId["a_plate1.upscale"].stage1Dims, { width: 960, height: 540 }, "half of the 1920x1080 finals frame");
  assert.equal(byId["a_plate1_still.still"].stage1Dims, undefined, "a still is one pass, no lattice");
  assert.deepEqual(checkJobsDoc(doc), []);

  const broken = JSON.parse(JSON.stringify(doc));
  broken.jobs.find((j) => j.id === "a_plate1.plate").stage1Dims = { width: 960, height: 544 };
  assert.ok(checkJobsDoc(broken).some((p) => /stage1Dims 960x544 is not half of dims 960x544/.test(p)));
});

test("an i2v source at a different aspect than its plate is refused, naming both", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_plate1_still.gen.inputs.width = 1024;
  pkg.assets.a_plate1_still.gen.inputs.height = 1024;
  assert.throws(() => planJobs(pkg), /first frame a_plate1_still is planned at 1024x1024 \(aspect 1\.000\) but this plate renders at 960x544/);
  assert.throws(() => planJobs(pkg), /generate it at the plate's aspect/);

  // a source within 1% of the plate's aspect is rounding noise, not a different shape
  const close = fixture("package-pending.json");
  close.assets.a_plate1_still.gen.inputs.width = 960;
  close.assets.a_plate1_still.gen.inputs.height = 540;
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
  assert.deepEqual(plate.dims, { width: 960, height: 544 });
  assert.equal(plate.frames, 97, "100 requested frames resolve to 97");
  assert.equal(plate.framesAdjusted, true);
  assert.equal(plate.fps, 24);
  const up = byId["a_plate1.upscale"];
  assert.deepEqual(up.upscaleTarget, { width: 1920, height: 1088 });
  assert.deepEqual(up.dims, { width: 1920, height: 1080 }, "x2 then crop to the package format");
  assert.deepEqual(up.crop, { top: 4, bottom: 4, left: 0, right: 0 });
  const still = byId["a_plate1_still.still"];
  assert.deepEqual(still.dims, { width: 960, height: 544 }, "961x545 rounds to multiples of 8 for a still");
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
