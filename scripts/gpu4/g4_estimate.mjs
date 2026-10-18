// GPU test 4 planning: the spend estimate, from the Google Colab backend's own measured numbers.
//
// Do NOT run a Google Colab session from here. This only *asks* the Colab backend what a job set would
// cost: `estimate()` is pure (H7 put the measured minutes in `MEASURED_JOB_MINUTES` and the bootstrap
// overhead in `BOOTSTRAP_OVERHEAD_MINUTES`), so this prints the same figure the run panel shows before
// anyone approves a session.
//
// usage: node scripts/gpu4/g4_estimate.mjs [--jobs <jobs.json>] [--units-budget 20]
//        (no --jobs: plan the GPU test 4 package itself)
import { readFileSync } from "node:fs";

import { createColabBackend } from "../../packages/backends/src/colab-backend.mjs";
import { planJobs } from "../../packages/jobs/src/index.mjs";
import { estimateLine, gpu4Package, PACKAGE_ID } from "./g4_package.mjs";

const argv = process.argv.slice(2);
const readFlag = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const budgetUnits = Number(readFlag("--units-budget", "20"));
const jobsPath = readFlag("--jobs");
const jobsDoc = jobsPath ? JSON.parse(readFileSync(jobsPath, "utf8")) : planJobs(gpu4Package());
if (!Array.isArray(jobsDoc.jobs)) {
  console.error(`${jobsPath} is not a comfyrizz.jobs/v1 document (no jobs array)`);
  process.exit(2);
}

// `estimate()` never touches the CLI (it is planning maths), so a stub that would throw is the honest
// thing to hand it: if the estimate ever starts calling Google Colab, this fails loudly instead of
// quietly reaching the network.
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
  scratchDir: "/tmp/comfyrizz-gpu4-estimate",
  logDir: "/tmp/comfyrizz-gpu4-estimate/logs",
  budgetUnits,
});

const estimate = await backend.estimate(jobsDoc.jobs);
const kinds = jobsDoc.jobs.reduce((counts, job) => ({ ...counts, [job.kind]: (counts[job.kind] ?? 0) + 1 }), {});
console.log(
  JSON.stringify(
    {
      jobs: jobsDoc.jobs.length,
      jobsByKind: kinds,
      jobsFile: jobsPath ?? "(planned from the GPU test 4 package)",
      ...estimateLine(estimate, { budgetUnits }),
      estimate,
    },
    null,
    2,
  ),
);
