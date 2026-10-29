// P-fix5: an agent-built package must pass the jobs planner without a caller
// supplying `planImage`. Before the fix, the agent dropped `gen.workflow_sha256`
// and `planJobs` refused the package (`gen.workflow_sha256 is required`), so
// "Run" on an agent-built package answered 400 and Export dropped the asset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCpuSlice } from '../../../packages/agent/dist/src/index.js';
import { WORKFLOW_SHA256 } from '../../../packages/agent/dist/src/workflow-manifest.js';
import { planJobs } from '../../../packages/jobs/src/index.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#6d8cff"/></svg>';

test('P-fix5: an agent-built package passes planJobs and carries the workflow hash', async () => {
  const slice = await runCpuSlice({
    brief: 'Icon, diagram, pattern, bars; nebula launch.',
    now: () => '2026-10-18T00:00:00.000Z',
    generateSvg: () => ({
      svg: SVG,
      attempts: 1,
      repairs: 0,
      sanitizerVersion: '1.0.0',
      renderCheck: { ok: true, version: '1.0.0', width: 512, height: 512, opaqueFraction: 0.6, outOfPaletteFraction: 0 },
    }),
  });

  const pending = Object.entries(slice.package.assets).find(([, asset]) => asset?.status === 'pending' && asset?.gen?.generator === 'flux3-klein');
  assert.ok(pending, 'the CPU slice plans one pending flux3-klein asset');
  const [assetId, asset] = pending;
  assert.equal(asset.gen.workflow, 'workflows/flux3_klein_t2i.api.json');
  assert.equal(asset.gen.workflow_sha256, WORKFLOW_SHA256['workflows/flux3_klein_t2i.api.json']);

  // The real gate: no throw, and the planned job keeps the hash for caching/audit.
  const doc = planJobs(slice.package);
  const job = doc.jobs.find(candidate => candidate.asset === assetId);
  assert.ok(job, `planJobs produced a job for ${assetId}`);
  assert.equal(job.workflowSha256, asset.gen.workflow_sha256);
});
