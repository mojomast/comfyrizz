import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planJobs, checkJobsDoc } from '../src/plan.mjs';
import { mediaFor, applyManifestToPackage } from '../src/apply.mjs';
import { validatePackage } from '../../schema/src/index.mjs';

const fixture = () => ({ id: 'pkg_h3test', revision: 1, format: { width: 1920, height: 1080, fps: 30 }, scenes: [], assets: {
  a_person: { kind: 'image', origin: 'uploaded', status: 'ready', file: 'refs/person.png', sha256: 'a'.repeat(64), media: { width: 256, height: 512 } },
  a_set: { kind: 'image', origin: 'uploaded', status: 'ready', file: 'refs/set.png', sha256: 'b'.repeat(64) },
  a_voice: { kind: 'audio', origin: 'uploaded', status: 'ready', file: 'refs/voice.wav', sha256: 'c'.repeat(64) },
  a_shot: { kind: 'video', origin: 'generated', status: 'pending', gen: {
    generator: 'fasth3-omni', workflow: 'workflows/fasth3_omni_ref2va.api.json', workflow_sha256: 'd'.repeat(64),
    inputs: { image: 'a_person', reference: 'a_set', audio: 'a_voice', width: 832, height: 480, frames: 240, fps: 24,
      role: 'background', prompt: 'The character says: "Lunch is a feature."', seed: 7 },
  } },
} });

test('H3 uses the AV grid, retains prompt, and treats portrait refs as identity not first frame', () => {
  const doc = planJobs(fixture());
  assert.deepEqual(checkJobsDoc(doc), []);
  const [job] = doc.jobs;
  assert.deepEqual(job.dims, { width: 832, height: 480 });
  assert.equal(job.frames, 243);
  assert.equal(job.fps, 24);
  assert.equal(job.stage1Dims, undefined);
  assert.equal(job.params.strength, undefined);
  assert.equal(job.params.role, undefined);
  assert.equal(job.params.prompt, fixture().assets.a_shot.gen.inputs.prompt);
  assert.deepEqual(job.fileInputs.map(f => f.param), ['image', 'reference', 'audio']);
  assert.equal(mediaFor(job).audio, 'present');
});

test('H3 reference content changes invalidate cache even when asset IDs are stable', () => {
  const pkg = fixture();
  const key = planJobs(pkg).jobs[0].cacheKey;
  pkg.assets.a_voice.sha256 = 'e'.repeat(64);
  assert.notEqual(planJobs(pkg).jobs[0].cacheKey, key);
});

test('H3 rejects LTX-only or incompatible timing inputs and missing voice', () => {
  for (const [name, value] of [['fps',30], ['frames',363], ['frames',NaN], ['upscale',true], ['audio',null]]) {
    const pkg = fixture(); pkg.assets.a_shot.gen.inputs[name] = value;
    assert.throws(() => planJobs(pkg), /FastH3/);
  }
});

test('applied H3 output preserves audio and does not silently assign unrestricted output rights', () => {
  const pkg = fixture(), doc = planJobs(pkg);
  const result = applyManifestToPackage(pkg, { jobsDoc: doc, manifest: { jobs: [{
    job: 'a_shot.plate', status: 'succeeded', outputs: [{ relative: 'assets/a_shot.mp4', bytes: 123, sha256: 'f'.repeat(64) }],
  }] } });
  const asset = result.package.assets.a_shot;
  assert.equal(asset.media.audio, 'present');
  assert.equal(asset.model_license.id, 'LicenseRef-MiniMax-H3-Community');
  assert.equal(asset.license.id, 'LicenseRef-MiniMax-H3-Community');
  assert.equal(asset.redistributable, false);
});

test('H3 generator and model-specific defaults validate in the package schema', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../schema/fixtures/valid/minimal.json', import.meta.url)));
  Object.assign(pkg.assets, fixture().assets);
  for (const asset of Object.values(pkg.assets)) {
    if (asset.origin !== 'uploaded') continue;
    asset.origin = 'upload';
    asset.license = { id: 'CC0-1.0' };
    asset.redistributable = true;
    asset.bytes = 123;
  }
  const result = validatePackage(pkg, { defaults: true });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.document.assets.a_shot.license.id, 'LicenseRef-MiniMax-H3-Community');
  assert.equal(result.document.assets.a_shot.redistributable, false);
});

test('native graph decodes both AV streams and keeps the published Omni recipe', () => {
  const graph = JSON.parse(readFileSync(new URL('../../../workflows/fasth3_omni_ref2va.api.json', import.meta.url)));
  assert.equal(graph['15'].inputs.steps, 8);
  assert.equal(graph['11'].inputs.selection, 'vsa');
  assert.equal(graph['11'].inputs['selection.keep_percent'], 10);
  assert.equal(graph['9'].inputs.shift_video, 12);
  assert.equal(graph['9'].inputs.shift_audio, 3);
  assert.deepEqual(graph['19'].inputs.audio, ['18', 0]);
  assert.equal(graph['18'].class_type, 'VAEDecodeAudio');
  for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
    if (Array.isArray(value)) assert.ok(graph[value[0]], `unresolved graph link ${value}`);
  }
});
