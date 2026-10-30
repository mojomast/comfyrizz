import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCpuSlice } from '../../../packages/agent/dist/src/index.js';
import { recordGenerationReceipts, verifyModelContribution, assertGenerationBrief } from '../../../packages/jobs/src/model-contribution.mjs';
import { createDeliverySnapshot, preflightDelivery, stageDeliverySnapshot } from '../src/productions/delivery-snapshot.mjs';
import { createExporter } from '../src/export.mjs';
import { renderPackageAsync } from '../../renderer/scripts/render-package-lib.mjs';
import { renderPackageIncremental, renderPackageIncrementalAsync } from '../../renderer/scripts/render-incremental.mjs';
import { prepareRenderJob } from '../src/pipeline-colab-render.mjs';
import { createDeliveryStore } from '../src/productions/delivery.mjs';
import { preferUpscaledAssets } from '../../renderer/scripts/render-package-lib.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfy-policy-integration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package'); mkdirSync(join(packageDir, 'assets'), { recursive: true });
  const { package: pkg } = await runCpuSlice({ brief: 'Ocean launch' });
  const [id, asset] = Object.entries(pkg.assets).find(([, a]) => a.gen?.generator === 'flux3-klein');
  const output = 'assets/mock-plate.png';
  // Mocked backend/renderer bytes are deliberately NOT a real-generation acceptance film.
  const bytes = Buffer.from('policy test output; no live ComfyUI generation');
  writeFileSync(join(packageDir, output), bytes);
  const graph = readFileSync(new URL(`../../../${asset.gen.workflow}`, import.meta.url));
  writeFileSync(join(packageDir, 'assets/mock-plate.workflow.api.json'), graph);
  Object.assign(asset, { status: 'ready', file: output, sha256: hash(bytes), bytes: bytes.length, media: { width: 1920, height: 1080 } });
  const jobsDoc = { hash: 'mock-approved-plan', jobs: [{ id: 'mock-still', generator: asset.gen.generator, workflow: asset.gen.workflow, workflowSha256: asset.gen.workflow_sha256, model: asset.gen.model }] };
  const manifest = { run_id: 'mock-run', jobsHash: jobsDoc.hash, jobs: [{ job: 'mock-still', status: 'succeeded', job_id: 'mock-comfy-job', attempt_id: 'mock-attempt', outputs: [{ relative: output, sha256: asset.sha256, workflow_submitted: true, measured: { width: 1920, height: 1080 } }] }] };
  const packagePath = join(packageDir, 'package.json');
  writeFileSync(packagePath, JSON.stringify(pkg));
  return { root, pkg, id, packageDir, packagePath, record: () => recordGenerationReceipts({ manifest, jobsDoc, outputDir: packageDir, backend: 'byo-comfyui' }) };
}

test('full, sync/async incremental and remote preparation reject claimed generation before rendering', async t => {
  const f = await fixture(t);
  const check = error => error.code === 'COMFY_MODEL_CONTRIBUTION_REQUIRED';
  await assert.rejects(() => renderPackageAsync(f.packagePath, join(f.root, 'full.mp4')), check);
  assert.throws(() => renderPackageIncremental(f.packagePath, join(f.root, 'incremental.mp4')), check);
  await assert.rejects(() => renderPackageIncrementalAsync(f.packagePath, join(f.root, 'async.mp4')), check);
  await assert.rejects(() => prepareRenderJob(f.packageDir), check);
});

test('snapshot/staging freeze contribution evidence and package-derived claims cannot pass final preflight', async t => {
  const f = await fixture(t);
  let snapshot = createDeliverySnapshot({ pkg: f.pkg, packageDir: f.packageDir });
  assert.equal(preflightDelivery(snapshot).ok, false);
  assert.equal(f.record().length, 1);
  snapshot = createDeliverySnapshot({ pkg: f.pkg, packageDir: f.packageDir });
  assert.equal(preflightDelivery(snapshot).ok, true);
  assert.equal(snapshot.modelContribution.evidence[0].receipt.jobId, 'mock-comfy-job');
  const staged = stageDeliverySnapshot({ snapshot, packageDir: f.packageDir });
  t.after(() => staged.cleanup());
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: staged.packageDir }).ok, true);
  writeFileSync(join(f.packageDir, f.pkg.assets[f.id].file), 'modified');
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.packageDir }).ok, false);
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: staged.packageDir }).ok, true);
});

test('export and cached/resumed export recheck receipts, include model use, and never override missing contribution', async t => {
  const f = await fixture(t); let renders = 0;
  const exportsDir = join(f.root, 'exports');
  const exporter = createExporter({ exportsDir, render: async (path, output) => {
    renders++;
    const pkg = JSON.parse(readFileSync(path));
    assert.equal(verifyModelContribution({ pkg, packageDir: join(path, '..') }).ok, true);
    writeFileSync(output, 'mock rendered movie'); return { output, frames: 1, bytes: 19 };
  } });
  await assert.rejects(() => exporter({ pkg: f.pkg, packagePath: f.packagePath, force: true }), { code: 'COMFY_MODEL_CONTRIBUTION_REQUIRED' });
  assert.equal(renders, 0);
  f.record();
  const first = await exporter({ pkg: f.pkg, packagePath: f.packagePath });
  assert.equal(first.reused, false);
  const receipt = JSON.parse(readFileSync(join(exportsDir, f.pkg.id, 'export-video.json')));
  assert.equal(receipt.modelContribution.evidence[0].receipt.family, 'FLUX 3 Image Klein');
  const again = await exporter({ pkg: f.pkg, packagePath: f.packagePath });
  assert.equal(again.reused, true); assert.equal(renders, 1);
  const store = createDeliveryStore({ runtimeDir: f.root });
  const snapshot = createDeliverySnapshot({ pkg: f.pkg, packageDir: f.packageDir });
  const bundle = { productionId: 'publication-test', packageDir: f.packageDir, snapshot,
    files: [{ path: 'video.mp4', kind: 'video', data: Buffer.from('mock rendered movie') }] };
  assert.equal(store.publishBundle(bundle).manifest.modelContribution[0].contribution.ok, true);
  assert.throws(() => store.publishBundle({ ...bundle, files: [{ path: 'video.mp4', kind: 'video', data: Buffer.from('unrelated video') }] }), { code: 'COMFY_RENDER_RECEIPT_REQUIRED' });
  // Even a caller's correct hash of an arbitrary movie is not a render receipt.
  writeFileSync(join(exportsDir, f.pkg.id, 'video.mp4'), 'unrelated video');
  const fresh = await exporter({ pkg: f.pkg, packagePath: f.packagePath, verifiedVideoSha256: hash('unrelated video') });
  assert.equal(fresh.reused, false); assert.equal(renders, 2);
  rmSync(join(f.root, '.comfy-provenance'), { recursive: true });
  await assert.rejects(() => exporter({ pkg: f.pkg, packagePath: f.packagePath }), { code: 'COMFY_MODEL_CONTRIBUTION_REQUIRED' });
  assert.equal(renders, 2);
});

test('final variants and measured timing cannot inherit base-file contribution', async t => {
  const f = await fixture(t); f.record();
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.packageDir }).ok, true);
  writeFileSync(join(f.packageDir, 'assets/untrusted-upscale.png'), 'unverified upscale');
  f.pkg.assets[f.id].variants = { upscaled: { file: 'assets/untrusted-upscale.png', width: 3840, height: 2160, sha256: hash('unverified upscale') } };
  const selected = preferUpscaledAssets(f.pkg, f.packageDir).pkg;
  assert.equal(selected.assets[f.id].sha256, hash('unverified upscale'));
  assert.equal(verifyModelContribution({ pkg: selected, packageDir: f.packageDir }).ok, false);
  const snapshot = createDeliverySnapshot({ pkg: f.pkg, packageDir: f.packageDir });
  for (const scene of snapshot.timeline.scenes) scene.durationInFrames = 1;
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.packageDir, timeline: snapshot.timeline }).ok, false);
});

test('explicit no-generated-media brief is an actionable conflict', () => {
  for (const brief of ['No generated media; native charts.', 'CPU-only title.', 'Use only procedural visuals.']) assert.throws(() => assertGenerationBrief(brief), { code: 'COMFY_MODEL_BRIEF_CONFLICT' });
  assert.doesNotThrow(() => assertGenerationBrief('Keep the lettering native; generated ocean background.'));
  assert.doesNotThrow(() => assertGenerationBrief('Use native-only text over a generated ocean background.'));
});
