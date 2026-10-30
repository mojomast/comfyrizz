// G6-10: the upscale variant has to be planned *bigger* than the plate it belongs to.
//
// The real GPU run at 10:52 produced all seven jobs and then had its render refused with
// SEM_ASSET_VARIANT_NOT_BIGGER /assets/a_plate1/variants/upscaled (960x576, got 960x576): the upscale job
// had been planned with the plate's own params, so the x2 graph rendered exactly the size it was given.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { planJobs } from "../src/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "..", "..", "pipeline-py", "tests", "fixtures", "package-gpu1-workflows.json");

test("an upscaled plate is asked for a size bigger than the plate (G6-10)", () => {
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  // the fixture is a contract fixture: it asks for the upscale the way the GPU 4/6 harnesses do
  pkg.assets.a_plate1.gen.inputs.upscale = true;
  const jobs = planJobs(pkg).jobs;
  const plate = jobs.find((job) => job.id === "a_plate1.plate");
  const upscale = jobs.find((job) => job.id === "a_plate1.upscale");

  assert.ok(plate && upscale, jobs.map((job) => job.id).join(", "));
  assert.ok(
    upscale.params.width > plate.params.width && upscale.params.height > plate.params.height,
    `the upscale asks for ${upscale.params.width}x${upscale.params.height}, the plate for ${plate.params.width}x${plate.params.height}`,
  );
  assert.deepEqual({ width: upscale.params.width, height: upscale.params.height }, upscale.dims, "the params and the planned dims agree");
});

test("an upscale keeps its generated raster on-lattice before delivery framing", () => {
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  pkg.assets.a_plate1.gen.inputs.upscale = true;
  const jobs = planJobs(pkg).jobs;
  const plate = jobs.find((job) => job.id === "a_plate1.plate");
  const upscale = jobs.find((job) => job.id === "a_plate1.upscale");

  // The graph has no crop node: passing 1080 would floor its half-resolution latent.
  assert.deepEqual(upscale.dims, { width: 1920, height: 1152 }, JSON.stringify(upscale.dims));
  assert.deepEqual(upscale.stage1Dims, { width: 960, height: 576 });
  assert.deepEqual(upscale.crop, { top: 36, bottom: 36, left: 0, right: 0 });
  assert.ok(upscale.dims.width > plate.params.width);
  assert.equal(upscale.params.width, upscale.dims.width, "the graph is asked for what the variant will be");
});

test("a plate with no upscale is untouched (G6-10)", () => {
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  delete pkg.assets.a_plate1.gen.inputs.upscale;
  const jobs = planJobs(pkg).jobs;
  assert.equal(jobs.some((job) => job.id === "a_plate1.upscale"), false, "no upscale was asked for");
  assert.equal(jobs.find((job) => job.id === "a_plate1.plate").params.upscale, undefined);
});
