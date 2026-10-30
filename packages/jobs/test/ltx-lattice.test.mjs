// RW-W1: regression lock for the LTX 2.5 two-stage geometry and frame lattice.
//
// The plan states the *final* frame size and the graph renders stage 1 at half of it, so a
// final size has to be a multiple of 64 for the half to stay on the 32-pixel lattice LTX
// floors to. 960x544 was the old default: half of 544 is 272, which LTX floors to 256, and the
// run came back 960x512 (docs/research/COMFY_LTX_QUALITY.md). This file locks the corrected
// behaviour documented in packages/jobs/src/plan.mjs. It is a regression lock, not red-first:
// it must pass on the base commit, because the base already carries the fix.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DIM_MULTIPLE,
  DIM_MULTIPLE_BY_KIND,
  FRAME_MODULUS,
  checkJobsDoc,
  isDimensionValid,
  isFrameCountValid,
  planJobs,
  resolveDimensions,
  resolveFrames,
} from "../src/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = () => JSON.parse(readFileSync(join(HERE, "fixtures", "package-pending.json"), "utf8"));

test("planned LTX finals are multiples of 64 and stage 1 is an exact half on the 32 lattice", () => {
  const doc = planJobs(fixture());
  const ltx = doc.jobs.filter((job) => job.kind === "plate" || job.kind === "upscale");
  assert.ok(ltx.length > 0, "the fixture plans LTX work");

  for (const job of ltx) {
    assert.equal(job.dims.width % DIM_MULTIPLE_BY_KIND.plate, 0, `${job.id} final width ${job.dims.width}`);
    assert.equal(job.dims.height % DIM_MULTIPLE_BY_KIND.plate, 0, `${job.id} final height ${job.dims.height}`);
    assert.ok(isDimensionValid(job.dims.width, DIM_MULTIPLE_BY_KIND.plate), `${job.id} final width`);
    assert.ok(isDimensionValid(job.dims.height, DIM_MULTIPLE_BY_KIND.plate), `${job.id} final height`);

    assert.deepEqual(
      job.stage1Dims,
      { width: job.dims.width / 2, height: job.dims.height / 2 },
      `${job.id} stage 1 is exactly half the final size`,
    );
    assert.equal(job.stage1Dims.width % DIM_MULTIPLE, 0, `${job.id} stage-1 width stays on the 32 lattice`);
    assert.equal(job.stage1Dims.height % DIM_MULTIPLE, 0, `${job.id} stage-1 height stays on the 32 lattice`);

    assert.deepEqual({ width: job.params.width, height: job.params.height }, job.dims, `${job.id} params and dims agree`);
  }
  assert.deepEqual(checkJobsDoc(doc), [], "the plan's own validator accepts every job");
});

test("960x544 resolves up to 960x576 so stage 1 is 480x288, never 480x272", () => {
  const resolved = resolveDimensions(960, 544, DIM_MULTIPLE_BY_KIND.plate);
  assert.deepEqual(resolved, {
    width: 960,
    height: 576,
    adjusted: true,
    requested: { width: 960, height: 544 },
  });
  assert.deepEqual(
    { width: resolved.width / 2, height: resolved.height / 2 },
    { width: 480, height: 288 },
    "544 ties up to 576 on the 64 lattice, so its half is on the 32 lattice",
  );
  assert.notEqual(resolved.height / 2, 272);
});

test("480x272 is rejected as a stage-1 size even when the halves agree", () => {
  // plan.mjs documents 480x272 as the half of 544 that LTX floors off the lattice; the validator
  // rejects it rather than letting the graph silently render a different final size.
  assert.equal(272 % DIM_MULTIPLE, 16, "272 is not a multiple of 32");

  const doc = planJobs(fixture());
  const plate = doc.jobs.find((job) => job.id === "a_plate1.plate");
  plate.dims = { width: 960, height: 544 };
  plate.stage1Dims = { width: 480, height: 272 };

  const problems = checkJobsDoc(doc);
  assert.ok(
    problems.some((problem) => /stage1Dims must be positive multiples of 32/.test(problem)),
    problems.join("\n"),
  );
  assert.ok(!problems.some((problem) => /is not half of dims/.test(problem)), "the halves still agree; the lattice is the failure");
});

test("a final request of 480x272 resolves onto the 64 lattice instead of being planned as asked", () => {
  // 480x272 is a plausible stage-1 size, but as a *final* request it is off the 64 lattice:
  // 480 rounds up to 512 (tie up) and 272 rounds down to 256, so the plate is planned 512x256.
  assert.deepEqual(resolveDimensions(480, 272, DIM_MULTIPLE_BY_KIND.plate), {
    width: 512,
    height: 256,
    adjusted: true,
    requested: { width: 480, height: 272 },
  });

  const pkg = fixture();
  delete pkg.assets.a_plate1.gen.inputs.image;
  pkg.assets.a_plate1.gen.inputs.width = 480;
  pkg.assets.a_plate1.gen.inputs.height = 272;
  const plate = planJobs(pkg).jobs.find((job) => job.id === "a_plate1.plate");

  assert.deepEqual(plate.dims, { width: 512, height: 256 });
  assert.equal(plate.dimsAdjusted, true);
  assert.deepEqual(plate.stage1Dims, { width: 256, height: 128 });
  assert.equal(plate.params.width, 512, "the graph is asked for the resolved size");
  assert.equal(plate.params.height, 256);
});

test("LTX frame counts are 8n+1 for the plate, its upscale and the params", () => {
  const doc = planJobs(fixture());
  const ltx = doc.jobs.filter((job) => job.kind === "plate" || job.kind === "upscale");
  for (const job of ltx) {
    assert.equal((job.frames - 1) % FRAME_MODULUS, 0, `${job.id} frames ${job.frames}`);
    assert.ok(isFrameCountValid(job.frames), `${job.id} frames`);
    assert.equal(job.params.frames, job.frames, `${job.id} params and job frames agree`);
    if (job.kind === "plate") assert.equal(job.framesAdjusted, true, "the fixture asks 100 frames, which resolves");
  }

  // 97 = 4.0 s at 24 fps, and 100 resolves down to it; 101 resolves up to 105.
  assert.equal(resolveFrames(97), 97);
  assert.equal(resolveFrames(100), 97);
  assert.equal(resolveFrames(101), 105);
  assert.equal(resolveFrames(121), 121);
});
