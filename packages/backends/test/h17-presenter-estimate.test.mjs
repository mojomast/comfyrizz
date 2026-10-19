// H17/GPU test 6: a presenter job's cost scales with the narration it covers.
//
// This test exists because the first GPU test 6 estimate crashed: the presenter branch in the estimate
// used a constant from the job defaults that the backend had never imported, and no suite covered it
// because no other harness plans a presenter. The dry run found it; this keeps it found.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createColabBackend, PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND } from "../src/colab-backend.mjs";
import { planJobs } from "../../jobs/src/index.mjs";
import { PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND as PLANNER_RATIO } from "../../jobs/src/defaults.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "..", "..", "pipeline-py", "tests", "fixtures", "package-gpu1-workflows.json");

const backend = () =>
  createColabBackend({
    cli: new Proxy({}, { get() { throw new Error("the estimate must not touch the CLI"); } }),
    packageId: "pkg_h17estimate0001",
    scratchDir: "/tmp/comfyrizz-h17-estimate",
    logDir: "/tmp/comfyrizz-h17-estimate/logs",
    budgetUnits: 2,
  });

test("the presenter is priced per video-second, not per job (H17)", async () => {
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const jobs = planJobs(pkg).jobs;
  const presenter = jobs.find((job) => job.kind === "presenter");
  assert.ok(presenter, "the fixture plans a presenter");

  const estimate = await backend().estimate(jobs);
  assert.ok(estimate.units > 0, JSON.stringify(estimate));

  // the same job with twice the frames has to cost more: that is the whole point of the ratio
  const longer = jobs.map((job) => (job === presenter ? { ...job, params: { ...job.params, frames: job.params.frames * 2 } } : job));
  const bigger = await backend().estimate(longer);
  assert.ok(bigger.units > estimate.units, `${bigger.units} should exceed ${estimate.units}`);
  // the estimate and the planner have to price a presenter the same way, or the card and the session
  // disagree about what a run costs
  assert.equal(PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND, PLANNER_RATIO);
});
