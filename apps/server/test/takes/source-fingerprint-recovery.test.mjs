// Synthetic collection fixtures, not evidence of model generation. Receipts are
// minted by the real collection writer; historical takes are ingested with the
// old staged-reference input, never made fresh by editing their fingerprints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { planJobs } from '../../../../packages/jobs/src/plan.mjs';
import { applyManifestToPackage } from '../../../../packages/jobs/src/apply.mjs';
import { recordGenerationReceipts } from '../../../../packages/jobs/src/model-contribution.mjs';
import { ingestRun } from '../../src/takes/ingest.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';
import { deriveClipState, genFingerprint } from '../../src/takes/model.mjs';
import { recoverPendingReferenceFingerprint } from '../../src/takes/source-fingerprint-recovery.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const workflow = name => readFileSync(new URL(`../../../../workflows/${name}.api.json`, import.meta.url));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const writeJson = (path, value) => write(path, JSON.stringify(value));

function fixture(t, { legacy = true, reverse = false, videoOnlyPreview = false } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'take-source-recovery-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const packageDir = join(runtimeDir, 'packages');
  const runId = 'run_recovery';
  const runDir = join(runtimeDir, 'runs', runId);
  const outputDir = join(runDir, 'out');
  const staged = JSON.parse(readFileSync(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url)));
  staged.assets = {};
  staged.voice.enabled = false;
  staged.theme = { palette: ['#000000', '#ffffff'], font: 'Inter' };
  staged.duration.targetFrames = 240;
  staged.renders = [];
  staged.scenes = [1, 2].map(i => ({ id: `shot${i}`, layout: 'title', variant: 'centered',
    preferredFrames: 120, copy: { headline: `COPY ${i}` }, data: null, locked: false,
    background: { asset: `a_video${i}`, fit: 'cover', loop: false } }));
  for (const i of [1, 2]) {
    for (const kind of ['image', 'video']) {
      const image = kind === 'image';
      const name = image ? 'flux3_klein_t2i' : 'ltx25_i2v_2stage';
      staged.assets[`a_${kind}${i}`] = { kind, origin: 'generated', status: 'pending',
        license: { id: 'CC0-1.0' }, redistributable: true,
        gen: { generator: image ? 'flux3-klein' : 'ltx25', workflow: `workflows/${name}.api.json`,
          workflow_sha256: sha(workflow(name)), model: image ? 'flux-3-klein' : 'ltx-2.5',
          inputs: { prompt: `A synthetic test scene ${i}`, width: 1920, height: 1080, seed: i,
            ...(image ? {} : { image: `a_image${i}`, fps: 24, frames: 153, strength: .85 }) }, backend: 'colab:G4' } };
    }
  }
  const jobsDoc = planJobs(staged);
  const manifest = { v: 1, run_id: 'synthetic-backend-run', jobsHash: jobsDoc.hash, complete: true,
    updatedAt: '2026-10-29T21:44:18+00:00', jobs: [] };
  const outputs = new Map();
  for (const job of jobsDoc.jobs) {
    const bytes = Buffer.from(`synthetic output bytes for ${job.id}`);
    const output = { relative: job.output, sha256: sha(bytes), bytes: bytes.length,
      workflow_submitted: true, measured: { width: 1920, height: 1088,
        ...(job.kind === 'plate' ? { fps: 24, frames: 153, durationSeconds: 6.375 } : {}) } };
    const graph = JSON.parse(workflow(job.kind === 'still' ? 'flux3_klein_t2i' : 'ltx25_i2v_2stage'));
    if (job.kind === 'plate') {
      const dep = outputs.get(job.deps[0]);
      const nodeId = Object.keys(graph).find(id => graph[id].class_type === 'LoadImage');
      const uploadedName = `${job.asset}_input.png`;
      graph[nodeId].inputs.image = uploadedName;
      output.conditioning_inputs = [{ nodeId, input: 'image', sha256: dep.sha256, bytes: dep.bytes, uploadedName }];
    }
    outputs.set(job.id, output);
    write(join(outputDir, job.output), bytes);
    writeJson(join(outputDir, job.output.replace(/\.[^/.]+$/, '.workflow.api.json')), graph);
    manifest.jobs.push({ job: job.id, status: 'succeeded', job_id: `prompt_${job.id}`, attempt_id: `attempt_${job.id}`, outputs: [output] });
  }
  if (reverse) manifest.jobs.reverse();
  writeJson(join(runDir, 'work', 'package.json'), staged);
  writeJson(join(runDir, 'work', 'jobs.json'), jobsDoc);
  writeJson(join(outputDir, 'manifest.json'), manifest);
  mkdirSync(packageDir, { recursive: true });
  assert.equal(recordGenerationReceipts({ manifest, jobsDoc, outputDir, packageDir, backend: 'colab' }).length, 4);
  const pkg = applyManifestToPackage(staged, { manifest, jobsDoc, outDir: outputDir, backend: 'colab:G4' }).package;
  for (const asset of Object.values(pkg.assets)) {
    mkdirSync(dirname(join(packageDir, asset.file)), { recursive: true });
    cpSync(join(outputDir, asset.file), join(packageDir, asset.file));
  }
  const store = createTakeStore({ runtimeDir, packageDir });
  // First preview has video1 and both dependencies. Video2 lands on the next
  // preview. Completion must never rewrite immutable takes to hide drift.
  const preview = { ...manifest, complete: false, jobs: manifest.jobs.filter(entry => videoOnlyPreview ? entry.job === 'a_video1.plate' : entry.job !== 'a_video2.plate') };
  const args = { pkg: staged, jobsDoc, outputDir, store, runId, backend: 'colab', ...(legacy ? { references: staged } : {}) };
  ingestRun({ ...args, manifest: preview });
  const previewDoc = store.read(staged.id);
  ingestRun({ ...args, manifest });
  const take = store.read(pkg.id).clips.a_video1.takes[0];
  return { runtimeDir, packageDir, runDir, outputDir, runId, pkg, staged, manifest, jobsDoc, store, take, previewDoc,
    prove: (overrides = {}) => recoverPendingReferenceFingerprint({ pkg, assetId: 'a_video1', take,
      runtimeDir, packageDir, takeRoot: store.packageRoot(pkg.id), ...overrides }) };
}

const state = (pkg, doc, assetId) => deriveClipState({ takes: doc.clips[assetId], assetGen: pkg.assets[assetId].gen, refs: pkg });

test('video-only preview waits for conditioning identities before recording its immutable take', t => {
  const ctx = fixture(t, { legacy: false, videoOnlyPreview: true });
  assert.equal(ctx.previewDoc?.clips?.a_video1?.takes?.length ?? 0, 0);
  const doc = ctx.store.read(ctx.pkg.id);
  assert.equal(doc.clips.a_video1.takes.length, 1);
  assert.equal(state(ctx.pkg, doc, 'a_video1'), 'review');
  assert.equal(doc.clips.a_video1.takes[0].sourceGenFingerprintRecovery, undefined);
  assert.equal(doc.clips.a_video1.takes[0].sourceGenFingerprint, genFingerprint(ctx.pkg.assets.a_video1.gen, ctx.pkg));
});

test('future previews fingerprint completed dependencies independent of manifest/completion order', t => {
  for (const reverse of [false, true]) {
    const ctx = fixture(t, { legacy: false, reverse });
    const doc = ctx.store.read(ctx.pkg.id);
    for (const id of ['a_video1', 'a_video2']) {
      assert.equal(state(ctx.pkg, doc, id), 'review');
      assert.equal(doc.clips[id].takes[0].sourceGenFingerprint, genFingerprint(ctx.pkg.assets[id].gen, ctx.pkg));
      assert.equal(doc.clips[id].takes.length, 1);
      assert.equal(doc.clips[id].takes[0].sourceGenFingerprintRecovery, undefined);
    }
    assert.equal(ctx.staged.assets.a_image1.status, 'pending');
    assert.equal(ctx.staged.assets.a_image1.sha256, undefined);
  }
});

test('newly adopted completed takes also retain their reference-content baseline', t => {
  const ctx = fixture(t, { legacy: false });
  const store = createTakeStore({ runtimeDir: join(ctx.runtimeDir, 'fresh-adoption'), packageDir: ctx.packageDir });
  const doc = store.adoptInitial(ctx.pkg);
  assert.equal(state(ctx.pkg, doc, 'a_video2'), 'review');
  assert.equal(doc.clips.a_video2.takes[0].sourceGenFingerprint, genFingerprint(ctx.pkg.assets.a_video2.gen, ctx.pkg));
  const changed = clone(ctx.pkg);
  changed.assets.a_image2.sha256 = 'a'.repeat(64);
  store.adoptInitial(changed);
  assert.equal(state(changed, store.read(ctx.pkg.id), 'a_video2'), 'stale');
});

test('verified legacy recovery preserves original fingerprint, media, receipts and unreviewed verdict', t => {
  const ctx = fixture(t);
  assert.equal(state(ctx.pkg, ctx.store.read(ctx.pkg.id), 'a_video1'), 'stale');
  const pkgBefore = clone(ctx.pkg);
  const takeBefore = clone(ctx.take);
  const receiptPath = join(ctx.runtimeDir, '.comfy-provenance', `${ctx.take.sha256}.json`);
  const receiptBefore = readFileSync(receiptPath);
  const proof = ctx.prove();
  assert.equal(proof.version, 1);
  assert.equal(proof.from, genFingerprint(ctx.staged.assets.a_video1.gen, ctx.staged));
  assert.equal(proof.to, genFingerprint(ctx.pkg.assets.a_video1.gen, ctx.pkg));
  ctx.store.adoptInitial(ctx.pkg);
  const doc = ctx.store.read(ctx.pkg.id);
  const recovered = doc.clips.a_video1.takes[0];
  assert.equal(state(ctx.pkg, doc, 'a_video1'), 'review');
  assert.equal(state(ctx.pkg, doc, 'a_video2'), 'review');
  assert.deepEqual(recovered, { ...takeBefore, sourceGenFingerprint: proof.to, sourceGenFingerprintRecovery: proof });
  assert.equal(recovered.verdict, 'unreviewed');
  assert.deepEqual(ctx.pkg, pkgBefore);
  assert.deepEqual(readFileSync(receiptPath), receiptBefore);
  ctx.store.adoptInitial(ctx.pkg);
  assert.deepEqual(ctx.store.read(ctx.pkg.id), doc, 'repeated reads do not rebase or rewrite evidence');
});

test('semantic generation edits and changed conditioning content remain stale before and after recovery', t => {
  const ctx = fixture(t);
  const edits = [
    pkg => { pkg.assets.a_video1.gen.inputs.prompt += ' edited'; },
    pkg => { pkg.assets.a_video1.gen.model = 'another-model'; },
    pkg => { pkg.assets.a_video1.gen.inputs.seed++; },
    pkg => { pkg.assets.a_image1.gen.inputs.prompt += ' edited'; },
    pkg => { pkg.assets.a_image1.gen.inputs.seed++; },
    pkg => { pkg.assets.a_image1.sha256 = 'a'.repeat(64); },
    pkg => { pkg.assets.a_image1.bytes++; },
    pkg => { pkg.assets.a_video1.gen.inputs.image = 'a_image2'; },
  ];
  for (const edit of edits) {
    const changed = clone(ctx.pkg); edit(changed);
    assert.equal(ctx.prove({ pkg: changed }), null);
  }
  ctx.store.adoptInitial(ctx.pkg);
  for (const edit of edits) {
    const changed = clone(ctx.pkg); edit(changed);
    ctx.store.adoptInitial(changed);
    assert.equal(state(changed, ctx.store.read(ctx.pkg.id), 'a_video1'), 'stale');
  }
});

test('bookkeeping provenance and a byte-identical reference path do not change generation meaning', t => {
  const ctx = fixture(t);
  const ref = ctx.pkg.assets.a_image1;
  const moved = 'assets/moved-reference.png';
  write(join(ctx.packageDir, moved), readFileSync(join(ctx.packageDir, ref.file)));
  ref.file = moved;
  ref.gen.created_at = '2026-10-30T00:00:00.000Z';
  ref.gen.job_id = 'bookkeeping-only-job';
  ctx.pkg.assets.a_video1.gen.backend = 'colab:G4';
  assert.ok(ctx.prove());
  ctx.store.adoptInitial(ctx.pkg);
  assert.equal(state(ctx.pkg, ctx.store.read(ctx.pkg.id), 'a_video1'), 'review');
});

test('missing/forged receipts, run plans, captured workflows and overwritten files cannot recover freshness', t => {
  const ctx = fixture(t);
  const receiptPath = join(ctx.runtimeDir, '.comfy-provenance', `${ctx.take.sha256}.json`);
  const receiptBytes = readFileSync(receiptPath);
  for (const change of [
    receipt => { receipt.jobsHash = 'a'.repeat(64); },
    receipt => { receipt.workflowSha256 = 'b'.repeat(64); },
    receipt => { receipt.conditioning.params.seed++; },
    receipt => { receipt.conditioning.consumed[0].sha256 = 'c'.repeat(64); },
    receipt => { receipt.outputSha256 = 'd'.repeat(64); },
    receipt => { receipt.capturedWorkflowSha256 = 'e'.repeat(64); },
  ]) {
    const forged = JSON.parse(receiptBytes); change(forged); writeJson(receiptPath, forged);
    assert.equal(ctx.prove(), null);
  }
  rmSync(receiptPath);
  write(join(ctx.packageDir, '.comfy-provenance', `${ctx.take.sha256}.json`), receiptBytes);
  assert.equal(ctx.prove(), null, 'a receipt imported into the package is not authority');
  write(receiptPath, receiptBytes);
  const files = [
    join(ctx.packageDir, ctx.pkg.assets.a_image1.file),
    join(ctx.packageDir, ctx.pkg.assets.a_video1.file),
    join(ctx.store.packageRoot(ctx.pkg.id), ctx.take.file),
    join(ctx.runDir, 'work', 'jobs.json'),
    join(ctx.runDir, 'work', 'package.json'),
    join(ctx.outputDir, ctx.pkg.assets.a_video1.file.replace(/\.[^/.]+$/, '.workflow.api.json')),
  ];
  for (const path of files) {
    const before = readFileSync(path); write(path, Buffer.from('overwritten'));
    assert.equal(ctx.prove(), null, path);
    write(path, before);
  }
  assert.ok(ctx.prove(), 'only the restored original evidence permits recovery');
});

test('a later conditioning overwrite with unchanged sha metadata revokes recovery on normal read', t => {
  const ctx = fixture(t);
  ctx.store.adoptInitial(ctx.pkg);
  const path = join(ctx.packageDir, ctx.pkg.assets.a_image1.file);
  const original = readFileSync(path);
  write(path, 'overwritten conditioning bytes');
  ctx.store.adoptInitial(ctx.pkg);
  const take = ctx.store.read(ctx.pkg.id).clips.a_video1.takes[0];
  assert.equal(take.sourceGenFingerprint, ctx.take.sourceGenFingerprint, 'original source evidence is retained');
  assert.equal(take.sourceGenFingerprintRecovery.invalidated, 'evidence-bytes-changed');
  assert.equal(state(ctx.pkg, ctx.store.read(ctx.pkg.id), 'a_video1'), 'stale');
  write(path, original);
  ctx.store.adoptInitial(ctx.pkg);
  assert.equal(state(ctx.pkg, ctx.store.read(ctx.pkg.id), 'a_video1'), 'review');
});
