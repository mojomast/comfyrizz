// Simulated successful ComfyUI collection for server contract tests only.
// These synthetic pixels are NOT evidence of real model generation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordGenerationReceipts, recordRenderedContribution } from '../../../../packages/jobs/src/model-contribution.mjs';
import { verifyAgainstManifest } from '../../../../packages/backends/src/run-package.mjs';
import { compileTimeline } from '../../../../packages/planner/dist/src/index.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const workflow = 'workflows/flux3_klein_t2i.api.json';
const graph = readFileSync(new URL(`../../../../${workflow}`, import.meta.url));
const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfJSEYysiH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBox0BDyZk1OQAAAAASUVORK5CYII=', 'base64');

export function plannedContribution(pkg, { sceneId, id = 'a_mock_comfy' } = {}) {
  const scene = sceneId ? pkg.scenes.find(s => s.id === sceneId) : pkg.scenes.find(s => !s.drawing && !s.composition && !['code', 'split', 'compare'].includes(s.layout));
  assert.ok(scene, 'fixture needs an ordinary visible scene for its mocked ComfyUI plate');
  pkg.assets[id] ??= { kind: 'image', origin: 'generated', status: 'pending', license: { id: 'CC0-1.0' }, redistributable: true,
    gen: { generator: 'flux3-klein', workflow, workflow_sha256: sha(graph), model: 'flux-3-klein', inputs: { prompt: 'A relevant editorial plate for the test film', width: 1024, height: 1024, seed: 17 } } };
  if (!scene.foreground?.some(item => item.asset === id)) (scene.foreground ??= []).push({ asset: id, x: .75, y: .75, w: .4, h: .4, z: 20 });
  return id;
}

export function collectMockContribution(pkg, packageDir, options = {}) {
  const id = plannedContribution(pkg, options);
  const relative = `assets/${id}.png`;
  mkdirSync(dirname(join(packageDir, relative)), { recursive: true });
  writeFileSync(join(packageDir, relative), pixels);
  writeFileSync(join(packageDir, `assets/${id}.workflow.api.json`), graph);
  const output = { relative, sha256: sha(pixels), bytes: pixels.length, workflow_submitted: true, measured: { width: 64, height: 64 } };
  const jobsDoc = { hash: sha('mock-approved-job'), jobs: [{ id: `${id}.still`, asset: id, generator: 'flux3-klein', workflow, workflowSha256: sha(graph), model: 'flux-3-klein' }] };
  const manifest = { complete: true, run_id: 'mock-comfy-run', jobsHash: jobsDoc.hash, jobs: [{ job: `${id}.still`, status: 'succeeded', job_id: 'mock-comfy-prompt', attempt_id: 'mock-attempt', outputs: [output] }] };
  assert.equal(verifyAgainstManifest(manifest, packageDir, { hashes: true }).verified, true);
  assert.equal(recordGenerationReceipts({ manifest, jobsDoc, outputDir: packageDir, backend: 'byo-comfyui' }).length, 1);
  Object.assign(pkg.assets[id], { status: 'ready', file: relative, sha256: output.sha256, bytes: output.bytes, media: output.measured });
  return { manifest, jobsDoc, id };
}

export function recordMockRender(pkg, packageDir, videoPath, timeline = compileTimeline(pkg)) {
  return recordRenderedContribution({ pkg, packageDir, timeline, videoPath });
}

export function seedMockContribution(store, pkg) {
  collectMockContribution(pkg, store.dir);
  return store.seed(pkg);
}
