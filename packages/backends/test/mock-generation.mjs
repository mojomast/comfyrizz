// Deterministic backend-boundary evidence only: these are simulated outputs and
// captures, never live ComfyUI generation or final-video acceptance evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contributionStore, verifyModelContribution } from "../../jobs/src/model-contribution.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const KLEIN_WORKFLOW = "workflows/flux3_klein_t2i.api.json";
const template = readFileSync(new URL(`../../../${KLEIN_WORKFLOW}`, import.meta.url));
export const KLEIN_SHA = sha256(template);

export function mockCapture(job) {
  assert.equal(job.workflow, KLEIN_WORKFLOW);
  assert.equal(job.workflowSha256, KLEIN_SHA);
  const graph = JSON.parse(template);
  graph["4"].inputs.text = job.params.prompt;
  Object.assign(graph["6"].inputs, { width: job.params.width, height: job.params.height });
  for (const key of ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"]) {
    if (job.params[key] !== undefined) graph["7"].inputs[key] = job.params[key];
  }
  return { relative: job.output.replace(/\.[^/.]+$/, ".workflow.api.json"), content: JSON.stringify(graph) };
}

export function mockOutput(job, content) {
  return {
    file: job.output, relative: job.output, sha256: sha256(content), bytes: Buffer.byteLength(content),
    workflow_submitted: true,
    measured: { width: job.params.width, height: job.params.height },
  };
}

export function assertCollectedReceipt(result, assetId) {
  const job = result.jobsDoc.jobs.find((job) => job.asset === assetId);
  assert.ok(job, `planned job for ${assetId}`);
  const entry = result.manifest.jobs.find((entry) => entry.job === job.id);
  const output = entry.outputs[0];
  const asset = result.package.assets[assetId];
  const receipt = result.generationReceipts.find((receipt) => receipt.plannedJobId === job.id);
  assert.ok(receipt, `trusted receipt for ${job.id}`);
  assert.equal(receipt.jobsHash, result.jobsDoc.hash);
  assert.equal(receipt.runId, result.manifest.run_id);
  assert.equal(receipt.jobId, entry.job_id);
  assert.equal(receipt.attemptId, entry.attempt_id);
  assert.equal(receipt.outputSha256, output.sha256);
  assert.equal(receipt.outputSha256, asset.sha256);
  assert.equal(asset.gen.job_id, entry.job_id);
  assert.equal(asset.gen.attempt_id, entry.attempt_id);
  assert.equal(receipt.workflowSha256, KLEIN_SHA);
  assert.equal(receipt.capturedWorkflowSha256, sha256(readFileSync(join(result.verification.dir, mockCapture(job).relative))));
  assert.deepEqual(receipt.measured, output.measured);
  assert.deepEqual(JSON.parse(readFileSync(join(contributionStore(result.verification.dir), `${output.sha256}.json`))), receipt);
  assert.equal(verifyModelContribution({ pkg: result.package, packageDir: result.verification.dir }).ok, true);
}
