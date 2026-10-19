// GPU test 6 planning: what the presenter-plus-mix session would cost, from the Colab backend's own
// measured numbers.
//
// Do NOT run a Google Colab session from here. `estimate()` is pure planning maths, so the CLI is a stub
// that throws if anything tries to reach it.
//
// usage: node scripts/gpu6/g6_estimate.mjs [--units-budget 2]
import { createColabBackend } from "../../packages/backends/src/colab-backend.mjs";
import { planJobs } from "../../packages/jobs/src/index.mjs";
import { estimateLine, gpu6Package, PACKAGE_ID } from "./g6_package.mjs";

const argv = process.argv.slice(2);
const readFlag = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const budgetUnits = Number(readFlag("--units-budget", "2"));

const refusingCli = new Proxy(
  {},
  {
    get() {
      throw new Error("estimate() must not call the Google Colab CLI");
    },
  },
);

const backend = createColabBackend({
  cli: refusingCli,
  packageId: PACKAGE_ID,
  scratchDir: "/tmp/comfyrizz-gpu6-estimate",
  logDir: "/tmp/comfyrizz-gpu6-estimate/logs",
  budgetUnits,
});

const jobsDoc = planJobs(gpu6Package());
const estimate = await backend.estimate(jobsDoc.jobs);
const kinds = jobsDoc.jobs.reduce((counts, job) => ({ ...counts, [job.kind]: (counts[job.kind] ?? 0) + 1 }), {});
console.log(
  JSON.stringify(
    {
      jobs: jobsDoc.jobs.length,
      jobsByKind: kinds,
      batches: [...new Set(jobsDoc.jobs.map((job) => job.batch))],
      ...estimateLine(estimate, { budgetUnits }),
      estimate,
    },
    null,
    2,
  ),
);
