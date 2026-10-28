import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planJobs } from '../src/plan.mjs';
import { reachableAssetIds, sceneAssetIds } from '../src/reachable.mjs';

const pendingImage = (id, inputs = {}) => [id, {
  kind: 'image', origin: 'generated', status: 'pending',
  gen: { generator: 'flux3-klein', workflow: 'workflows/flux3_klein_t2i.api.json', workflow_sha256: 'a'.repeat(64), inputs: { width: 832, height: 480, ...inputs } },
}];

function fixture() {
  return {
    id: 'pkg_reachable', revision: 1, format: { width: 1920, height: 1080, fps: 30 },
    cast: [{ id: 'c_unused', ref_asset: 'a_orphan_restyle' }],
    scenes: [{ id: 's_shot', layout: 'list', preferredFrames: 180, media_only: true, background: { asset: 'a_shot' }, media: [{ asset: 'a_shot' }, { asset: 'a_shot' }] }],
    assets: Object.fromEntries([
      pendingImage('a_identity'),
      pendingImage('a_composition'),
      pendingImage('a_orphan_restyle', { reference: 'a_identity' }),
      ['a_silence', { kind: 'audio', origin: 'upload', status: 'ready', file: 'assets/silence.wav', sha256: 'c'.repeat(64), media: { durationSeconds: 0.5 } }],
      ['a_shot', {
        kind: 'video', origin: 'generated', status: 'pending',
        gen: {
          generator: 'fasth3-omni', workflow: 'workflows/fasth3_omni_ref2va.api.json', workflow_sha256: 'b'.repeat(64),
          direction: { subject: 'A felt jerboa', composition: 'At a lighthouse', action: 'It hauls a lens', camera: 'Slow push', soundscape: 'Coastal wind', characterCount: 1 },
          inputs: { image: 'a_identity', reference: 'a_composition', audio: 'a_silence', width: 832, height: 480, frames: 158, fps: 24 },
        },
      }],
    ]),
  };
}

test('whole-package jobs are one scene-reachable closure; orphan restyles never become paid jobs', () => {
  const pkg = fixture();
  const reachable = reachableAssetIds(pkg);
  assert.deepEqual([...reachable].sort(), ['a_composition', 'a_identity', 'a_shot', 'a_silence']);
  const doc = planJobs(pkg);
  assert.deepEqual(doc.jobs.map(job => job.asset).sort(), ['a_composition', 'a_identity', 'a_shot']);
  assert.ok(!doc.jobs.some(job => job.asset === 'a_orphan_restyle'));
  assert.ok(doc.skipped.some(entry => entry.asset === 'a_orphan_restyle' && /not reachable/.test(entry.reason)));
  const shot = doc.jobs.find(job => job.asset === 'a_shot');
  assert.equal(shot.scene, 's_shot');
  assert.deepEqual(shot.deps.sort(), ['a_composition.still', 'a_identity.still']);
  assert.ok(shot.fileInputs.some(input => input.param === 'audio' && input.path === 'assets/silence.wav'));
});

test('scene.media maps correctly and explicit asset planning retains required refs', () => {
  const pkg = fixture();
  assert.deepEqual(sceneAssetIds(pkg.scenes[0]), ['a_shot']);
  const doc = planJobs(pkg, { assets: ['a_orphan_restyle'] });
  assert.deepEqual(doc.jobs.map(job => job.asset).sort(), ['a_identity', 'a_orphan_restyle']);
  assert.ok(doc.jobs.find(job => job.asset === 'a_orphan_restyle').deps.includes('a_identity.still'));
});
