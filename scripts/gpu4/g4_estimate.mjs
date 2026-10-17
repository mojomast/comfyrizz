// GPU test 4 planning: the spend estimate, from the backend's own measured numbers.
//
// Do NOT run a Google Colab session from here. This only *asks* the Colab backend what a job set
// would cost: `estimate()` is pure (H7 put the measured minutes in `MEASURED_JOB_MINUTES` and the
// bootstrap overhead in `BOOTSTRAP_OVERHEAD_MINUTES`), so the harness can print the same figure the
// run panel would show before anyone approves a session.
//
// usage: node scripts/gpu4/g4_estimate.mjs <jobs.json> [--units-budget 20]
import { readFileSync } from "node:fs";

import { createColabBackend } from "../../packages/backends/src/colab-backend.mjs";

const [jobsPath, ...rest] = process.argv.slice(2);
if (!jobsPath) {
  console.error("usage: node scripts/gpu4/g4_estimate.mjs <jobs.json> [--units-budget 20]");
  process.exit(2);
}
const budgetIndex = rest.indexOf("--units-budget");
const budgetUnits = budgetIndex >= 0 ? Number(rest[budgetIndex + 1]) : 20;

const jobsDoc = JSON.parse(readFileSync(jobsPath, "utf8"));
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
  packageId: "pkg_gpu4estimate",
  scratchDir: "/tmp/comfyrizz-gpu4-estimate",
  logDir: "/tmp/comfyrizz-gpu4-estimate/logs",
  budgetUnits,
});

const estimate = await backend.estimate(jobsDoc.jobs);
console.log(JSON.stringify({ jobs: jobsDoc.jobs.length, budgetUnits, estimate }, null, 2));
