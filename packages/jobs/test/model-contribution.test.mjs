import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordGenerationReceipts, verifyModelContribution, plannedModelContribution, copyGenerationReceipts } from '../src/model-contribution.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfy-contribution-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'package'); mkdirSync(join(dir, 'assets'), { recursive: true });
  const workflow = 'workflows/flux3_klein_t2i.api.json';
  const graph = readFileSync(new URL(`../../../${workflow}`, import.meta.url));
  // Mock backend output only. These bytes are never presented as live generation evidence.
  const bytes = Buffer.from('mock ComfyUI output used only by policy integration tests');
  writeFileSync(join(dir, 'assets/plate.png'), bytes);
  writeFileSync(join(dir, 'assets/plate.workflow.api.json'), graph);
  const pkg = JSON.parse(readFileSync(new URL('../../schema/fixtures/valid/minimal.json', import.meta.url)));
  pkg.assets = { a_plate: { kind: 'image', origin: 'generated', status: 'ready', file: 'assets/plate.png', sha256: hash(bytes), bytes: bytes.length, license: { id: 'CC0-1.0' }, redistributable: true, media: { width: 1920, height: 1080 }, gen: { generator: 'flux3-klein', workflow, workflow_sha256: hash(graph) } } };
  delete pkg.theme.logo_asset;
  pkg.scenes[0].background = { asset: 'a_plate' };
  pkg.scenes[0].transitionOut = { type: 'cut', frames: 0 };
  const jobsDoc = { hash: 'trusted-plan-hash', jobs: [{ id: 'a_plate.still', generator: 'flux3-klein', workflow, workflowSha256: hash(graph), model: 'flux-3-klein', inputs: { prompt: 'Relevant sea plate' } }] };
  const manifest = { jobsHash: jobsDoc.hash, run_id: 'mock-run', jobs: [{ job: 'a_plate.still', status: 'succeeded', job_id: 'comfy-prompt-id', attempt_id: 'attempt-1', outputs: [{ relative: 'assets/plate.png', sha256: hash(bytes), bytes: bytes.length, workflow_submitted: true, measured: { width: 1920, height: 1080 } }] }] };
  const record = () => recordGenerationReceipts({ manifest, jobsDoc, outputDir: dir, backend: 'byo-comfyui' });
  return { pkg, dir, root, graph, manifest, jobsDoc, record };
}

test('server receipt binds successful job, pinned workflow/checkpoint, output bytes and visible render placement', t => {
  const f = fixture(t);
  assert.equal(plannedModelContribution(f.pkg)[0].model, 'FLUX 3 Image Klein');
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, false, 'package gen metadata alone is never proof');
  assert.equal(f.record().length, 1);
  const result = verifyModelContribution({ pkg: f.pkg, packageDir: f.dir });
  assert.equal(result.ok, true);
  assert.equal(result.evidence[0].receipt.jobId, 'comfy-prompt-id');
  assert.equal(result.evidence[0].receipt.capturedWorkflowSha256, hash(f.graph));
  assert.equal(result.evidence[0].sceneId, 's1');
  assert.equal(result.evidence[0].slot, 'background');
});

test('model registration uses the exact committed FLUX, LTX and H3 workflows; guessed aliases do not qualify', t => {
  const f = fixture(t);
  for (const [generator, workflow, family] of [
    ['flux3-klein', 'flux3_klein_ref2_edit', 'FLUX 3 Image Klein'],
    ['ltx25', 'ltx25_t2v_2stage', 'LTX 2.5'],
    ['ltx25-a2v', 'ltx25_a2v_2stage', 'LTX 2.5'],
    ['fasth3-omni', 'fasth3_omni_ref2va', 'MiniMax H3'],
    ['fasth3-omni', 'fasth3_omni_ref2v_noclip', 'MiniMax H3'],
  ]) {
    const path = `workflows/${workflow}.api.json`;
    f.pkg.assets.a_plate.gen = { generator, workflow: path, workflow_sha256: hash(readFileSync(new URL(`../../../${path}`, import.meta.url))) };
    assert.equal(plannedModelContribution(f.pkg)[0]?.model, family);
  }
  f.pkg.assets.a_plate.gen.generator = 'minimaxH3';
  assert.deepEqual(plannedModelContribution(f.pkg), []);
});

test('failed, cached-without-proof, missing server identity, changed workflow and mismatched outputs cannot mint receipts', t => {
  const fake = fixture(t);
  assert.deepEqual(recordGenerationReceipts({ manifest: fake.manifest, jobsDoc: fake.jobsDoc, outputDir: fake.dir, backend: 'cpu' }), []);
  for (const mutate of [
    f => { f.manifest.jobs[0].status = 'failed'; },
    f => { f.manifest.jobs[0].status = 'cached'; },
    f => { f.manifest.jobs[0].outputs[0].workflow_submitted = false; },
    f => { f.manifest.jobs[0].outputs[0].measured = { width: 1, height: 1 }; },
    f => { const graph = JSON.parse(f.graph); const node = Object.values(graph).find(n => n.class_type === 'SaveImage'); node.inputs.images = ['1', 0]; writeFileSync(join(f.dir, 'assets/plate.workflow.api.json'), JSON.stringify(graph)); },
    f => { delete f.manifest.jobs[0].job_id; },
    f => { f.manifest.jobsHash = 'different'; },
    f => { f.jobsDoc.jobs[0].workflowSha256 = '0'.repeat(64); },
    f => { f.manifest.jobs[0].outputs[0].sha256 = '0'.repeat(64); },
    f => { const graph = JSON.parse(f.graph); graph['1'].inputs.unet_name = 'not-an-allowed-model.safetensors'; writeFileSync(join(f.dir, 'assets/plate.workflow.api.json'), JSON.stringify(graph)); },
  ]) {
    const f = fixture(t); mutate(f); assert.equal(f.record().length, 0); assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, false);
  }
});

test('orphan, pending, hidden drawing, procedural precedence, scrim and offscreen placements fail closed', t => {
  for (const mutate of [
    pkg => { delete pkg.scenes[0].background; },
    pkg => { pkg.assets.a_plate.status = 'pending'; },
    pkg => { pkg.scenes[0].drawing = { elements: [] }; },
    pkg => { pkg.scenes[0].background.procedural = { pattern: 'gradient' }; },
    pkg => { pkg.scenes[0].background.scrim = 1; },
    pkg => { delete pkg.scenes[0].background; pkg.scenes[0].foreground = [{ asset: 'a_plate', x: 2, y: .5, w: .1, h: .1 }]; },
    pkg => { delete pkg.scenes[0].background; pkg.scenes[0].foreground = [{ asset: 'a_plate', x: .5, y: .5, w: .01, h: .01 }]; },
    pkg => { delete pkg.scenes[0].background; pkg.scenes[0].foreground = [{ asset: 'a_plate', x: .5, y: .5, w: 1, h: 1, z: -1 }]; },
    pkg => { pkg.assets.a_cover = { ...pkg.assets.a_plate, origin: 'uploaded', sha256: '0'.repeat(64) }; pkg.scenes[0].foreground = [{ asset: 'a_cover', w: 1, h: 1, x: .5, y: .5 }]; },
  ]) {
    const f = fixture(t); f.record(); mutate(f.pkg); assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, false);
  }
});

test('changed bytes fail on resume, honest receipt reuse survives server staging, uploaded receipt files do not', t => {
  const f = fixture(t); f.record();
  const staged = join(f.root, 'new-root', 'package'); mkdirSync(join(staged, 'assets'), { recursive: true });
  writeFileSync(join(staged, 'assets/plate.png'), readFileSync(join(f.dir, 'assets/plate.png')));
  writeFileSync(join(staged, 'assets/forged-receipt.json'), JSON.stringify(f.manifest));
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: staged }).ok, false);
  copyGenerationReceipts({ pkg: f.pkg, sourceDir: f.dir, packageDir: staged });
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: staged }).ok, true);
  writeFileSync(join(staged, 'assets/plate.png'), 'changed');
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: staged }).ok, false);
});
