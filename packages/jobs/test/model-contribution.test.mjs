import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contributionStore, recordGenerationReceipts, verifyModelContribution, plannedModelContribution, copyGenerationReceipts } from '../src/model-contribution.mjs';

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

test('unconnected Klein references cannot mint receipts while one/two-reference graphs remain eligible', t => {
  for (const count of [1, 2]) {
    const f = fixture(t);
    const job = f.jobsDoc.jobs[0];
    job.workflow = `workflows/flux3_klein_ref${count === 2 ? '2' : ''}_edit.api.json`;
    const graph = readFileSync(new URL(`../../../${job.workflow}`, import.meta.url));
    job.workflowSha256 = hash(graph);
    job.params = { reference: 'first.png', ...(count === 2 ? { _reference_2: 'second.png' } : {}) };
    writeFileSync(join(f.dir, 'assets/plate.workflow.api.json'), graph);
    assert.equal(f.record().length, 1, `${count} connected reference graph remains eligible`);
  }
  for (const mutate of [
    job => { job.params = { reference: 'first.png', _reference_2: 'second.png', _reference_3: 'third.png' }; },
    job => { job.params = { images: ['first.png', 'second.png', 'third.png'] }; },
    job => { job.fileInputs = [{ param: '_reference_3', from: 'package', path: 'assets/third.png' }]; },
  ]) {
    const f = fixture(t); mutate(f.jobsDoc.jobs[0]);
    assert.deepEqual(f.record(), [], 'no trusted receipt may claim this unconnected source was consumed');
    assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, false);
  }
  const historical = fixture(t);
  const [receipt] = historical.record();
  receipt.conditioning.params = { reference: 'first.png', _reference_3: 'third.png' };
  writeFileSync(join(historical.root, '.comfy-provenance', `${receipt.outputSha256}.json`), JSON.stringify(receipt));
  assert.equal(verifyModelContribution({ pkg: historical.pkg, packageDir: historical.dir }).ok, false,
    'an old receipt claiming an unconnected third reference cannot bypass the completed-receipt gate');
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

test('contained comparison images count only their source-pixel area using receipt measurements', t => {
  const f = fixture(t); f.record();
  const scene = f.pkg.scenes[0];
  scene.layout = 'compare';
  scene.media = [{ asset: 'a_plate', fit: 'contain', label: 'BEFORE' }, { asset: 'a_plate', fit: 'contain', label: 'AFTER' }];
  const verify = () => verifyModelContribution({ pkg: f.pkg, packageDir: f.dir });
  assert.equal(verify().evidence.length, 2);
  for (const use of verify().evidence) assert.equal(use.visibleFraction, .25, 'wide image occupies half of a half-width panel');
  f.pkg.assets.a_plate.media = { width: 1, height: 100000 };
  assert.equal(verify().evidence[0].visibleFraction, .25, 'editable dimensions cannot override trusted measurements');
  f.pkg.format.width = 1080; f.pkg.format.height = 1920;
  assert.ok(verify().evidence.every(use => Math.abs(use.visibleFraction - .31640625) < 1e-9), 'stacked panels follow portrait geometry');
  scene.media[0].procedural = { pattern: 'gradient' };
  assert.deepEqual(verify().evidence.map(use => use.slot), ['media.1'], 'procedural plate shadows an asset');
});

test('contain cannot qualify a tiny source-pixel footprint or unmeasured planned source', t => {
  const f = fixture(t);
  f.pkg.scenes[0].background.fit = 'contain';
  f.pkg.assets.a_plate.media = { width: 100000, height: 1 };
  assert.deepEqual(plannedModelContribution(f.pkg), []);
  delete f.pkg.assets.a_plate.media;
  assert.deepEqual(plannedModelContribution(f.pkg), []);
  f.pkg.assets.a_plate.gen.inputs = { width: 1920, height: 1080 };
  assert.equal(plannedModelContribution(f.pkg).length, 1, 'generation dimensions may establish provisional planning geometry');
  f.manifest.jobs[0].outputs[0].measured = { width: 100000, height: 2 };
  f.record();
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, false, 'final geometry never falls back to planned dimensions');
});

// Exact production 804d7c2 graph hashes, not hashes calculated from today's files.
const oldLtxGraphs = [
  ['ltx25', 'ltx25_i2v_2stage', '97e205ad993996ac937a9a65ef7040973260bdc939041a23c3109184dc48c5e3'],
  ['ltx25', 'ltx25_t2v_2stage', '4975aa404c21e04a470db76327eef2548397ffe893c67475f70e42c9d66c8847'],
  ['ltx25-a2v', 'ltx25_a2v_2stage', '81b7701ecbe172df0e73ca19a3cbc9e236b84842c6ddf5aa928527c0c9e20f70'],
];
function ltxFixture(t, [generator, name, oldHash]) {
  const f = fixture(t), workflow = `workflows/${name}.api.json`;
  const graph = readFileSync(new URL(`../../../${workflow}`, import.meta.url));
  f.pkg.assets.a_plate.kind = 'video';
  f.pkg.assets.a_plate.gen = { generator, workflow, workflow_sha256: hash(graph) };
  Object.assign(f.jobsDoc.jobs[0], { generator, workflow, workflowSha256: hash(graph) });
  f.jobsDoc.hash = hash('mock server-owned plan'); f.manifest.jobsHash = f.jobsDoc.hash;
  writeFileSync(join(f.dir, 'assets/plate.workflow.api.json'), graph);
  return { ...f, oldHash };
}
function seedHistoricalReceipt(f) {
  // Test-only simulation of a ledger entry written before the graph upgrade.
  // Production has no API that mints these from an old hash.
  const receipt = { schema: 'comfyrizz.comfy-contribution/v1', status: 'succeeded', backend: 'byo-comfyui',
    runId: 'mock-old-run', jobId: 'mock-old-job', attemptId: 'mock-old-attempt', plannedJobId: 'a_plate.plate',
    jobsHash: f.jobsDoc.hash, capturedWorkflowSha256: hash('mock old captured graph'),
    generator: f.pkg.assets.a_plate.gen.generator, workflow: f.pkg.assets.a_plate.gen.workflow, workflowSha256: f.oldHash,
    checkpoint: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', family: 'LTX 2.5',
    outputSha256: f.pkg.assets.a_plate.sha256, bytes: f.pkg.assets.a_plate.bytes, measured: { width: 1024, height: 576 } };
  const store = contributionStore(f.dir); mkdirSync(store, { recursive: true });
  const path = join(store, `${receipt.outputSha256}.json`);
  writeFileSync(path, JSON.stringify(receipt));
  f.pkg.assets.a_plate.gen.workflow_sha256 = f.oldHash;
  return { receipt, path };
}

for (const graph of oldLtxGraphs) test(`${graph[1]}: current minting works; old completed evidence remains readable and copyable`, t => {
  const f = ltxFixture(t, graph);
  assert.equal(f.record().length, 1);
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, true);
  const { receipt, path } = seedHistoricalReceipt(f);
  const original = readFileSync(path);
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, true);
  assert.deepEqual(readFileSync(path), original, 'reading never rewrites old hashes');
  assert.deepEqual(plannedModelContribution(f.pkg), [], 'historical hash does not admit a generation plan');
  const staged = join(f.root, 'staged-root', 'package'); mkdirSync(join(staged, 'assets'), { recursive: true });
  writeFileSync(join(staged, f.pkg.assets.a_plate.file), readFileSync(join(f.dir, f.pkg.assets.a_plate.file)));
  copyGenerationReceipts({ pkg: f.pkg, sourceDir: f.dir, packageDir: staged });
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: staged }).ok, true);
  delete receipt.checkpoint;
  writeFileSync(path, JSON.stringify(receipt));
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, true, 'legacy checkpoint omission uses the audited graph pin');
});

test('historical receipt reads fail closed on identity, checkpoint, completion, location and byte mismatches', t => {
  for (const mutate of [
    r => { r.workflowSha256 = '0'.repeat(64); },
    r => { r.workflow = 'workflows/ltx25_t2v_2stage.api.json'; },
    r => { r.workflow = '../workflows/ltx25_i2v_2stage.api.json'; },
    r => { r.workflow = ['workflows/ltx25_i2v_2stage.api.json']; },
    r => { r.generator = 'ltx25-a2v'; },
    r => { r.generator = '__proto__'; },
    r => { r.checkpoint = 'unapproved.safetensors'; },
    r => { r.checkpoint = null; },
    r => { r.family = 'MiniMax H3'; },
    r => { r.schema = 'imported'; },
    r => { r.status = 'cached'; },
    r => { r.backend = 'cpu'; },
    r => { r.runId = ''; },
    r => { delete r.jobId; },
    r => { r.attemptId = {}; },
    r => { delete r.plannedJobId; },
    r => { r.jobsHash = 'unverified'; },
    r => { delete r.capturedWorkflowSha256; },
    r => { r.outputSha256 = '0'.repeat(64); },
    r => { r.bytes += 1; },
    r => { r.measured.width = '1024'; },
  ]) {
    const f = ltxFixture(t, oldLtxGraphs[0]); const { receipt, path } = seedHistoricalReceipt(f);
    mutate(receipt); writeFileSync(path, JSON.stringify(receipt));
    assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, false, mutate.toString());
  }
  const f = ltxFixture(t, oldLtxGraphs[0]), { path } = seedHistoricalReceipt(f);
  writeFileSync(join(f.dir, 'assets/uploaded-receipt.json'), readFileSync(path)); rmSync(path);
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, false, 'uploaded sidecar is not trusted');
  seedHistoricalReceipt(f); writeFileSync(join(f.dir, f.pkg.assets.a_plate.file), 'changed output bytes');
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, false);
});

for (const graph of oldLtxGraphs) test(`${graph[1]}: an old hash cannot mint a receipt or authorize pending generation`, t => {
  const f = ltxFixture(t, graph);
  f.jobsDoc.jobs[0].workflowSha256 = f.oldHash;
  f.pkg.assets.a_plate.gen.workflow_sha256 = f.oldHash;
  f.pkg.assets.a_plate.status = 'pending';
  assert.deepEqual(f.record(), [], 'even a submitted current capture cannot mint against an old hash');
  assert.deepEqual(plannedModelContribution(f.pkg), []);
  assert.equal(verifyModelContribution({ pkg: f.pkg, packageDir: f.dir }).ok, false);
  // Restoring the current hash does not allow an unapproved loader in the capture.
  f.jobsDoc.jobs[0].workflowSha256 = hash(readFileSync(new URL(`../../../${f.jobsDoc.jobs[0].workflow}`, import.meta.url)));
  const capture = JSON.parse(readFileSync(join(f.dir, 'assets/plate.workflow.api.json')));
  capture['1'].inputs.unet_name = 'unapproved.safetensors';
  writeFileSync(join(f.dir, 'assets/plate.workflow.api.json'), JSON.stringify(capture));
  assert.deepEqual(f.record(), []);
});
