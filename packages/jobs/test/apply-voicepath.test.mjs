// VX07: an applied FastH3 plate records which voice path the plan used.
//
// Prompt mode (VX05) executes the committed no-clip graph and generates the voice from a written
// description, so the ready asset says `voicePath: 'prompt'`. Clip mode is the default behaviour
// and must stay exactly as it was: no voicePath field, and the native audio still present.
//
// The applied package must still validate: the asset schema accepts only 'prompt' (absent means
// clip), so an applied result can actually be written back as a package.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyManifestToPackage } from '../src/apply.mjs';
import { FASTH3_NOCLIP_WORKFLOW, planJobs } from '../src/plan.mjs';
import { validatePackage } from '../../schema/src/index.mjs';

const SHA = 'e'.repeat(64);
const DESCRIPTION = 'Warm, low narrator; unhurried (never imitates anyone).';
const VOICE_SEED = 314159;

function basePackage() {
  return {
    schemaVersion: 1,
    id: 'pkg_vx07',
    revision: 1,
    title: 'VX07 prompt voice',
    format: { width: 1920, height: 1080, fps: 24 },
    duration: { mode: 'target', targetFrames: 96 },
    scenes: [{
      id: 's1', layout: 'hero', preferredFrames: 96,
      copy: { headline: 'Prompt voice' },
      background: { asset: 'a_shot', speed: 1 },
    }],
    assets: {
      a_person: {
        kind: 'image', origin: 'upload', status: 'ready',
        file: 'refs/person.png', sha256: 'a'.repeat(64),
      },
      a_set: {
        kind: 'image', origin: 'upload', status: 'ready',
        file: 'refs/set.png', sha256: 'b'.repeat(64),
      },
      a_voice: {
        kind: 'audio', origin: 'upload', status: 'ready',
        file: 'refs/voice.wav', sha256: 'c'.repeat(64), media: { durationSeconds: 2.8 },
      },
      a_shot: {
        kind: 'video', origin: 'generated', status: 'pending',
        gen: {
          generator: 'fasth3-omni',
          workflow: 'workflows/fasth3_omni_ref2va.api.json',
          workflow_sha256: 'd'.repeat(64),
          inputs: {
            image: 'a_person', reference: 'a_set', audio: 'a_voice',
            width: 832, height: 480, frames: 96, fps: 24, seed: 7,
          },
          direction: {
            subject: 'one armored bear',
            composition: 'The bear braces a beam with their shoulder.',
            action: 'The beam settles as the bear speaks.',
            camera: 'Hold a medium close-up.',
            characterCount: 1,
            soundscape: 'A low engine hum and one metal creak.',
            reactionSeconds: 0.5,
            dialogue: {
              text: 'Roof heavy. Bear expensive.',
              conditioningText: 'Roof heavy. Bear expensive.',
              language: 'English',
              voice: 'bear',
              delivery: 'strained, broken English as written',
            },
          },
        },
      },
    },
    compliance: { open_weights_only: true, backends_used: [] },
  };
}

function clipPackage() {
  return basePackage();
}

function promptPackage() {
  const pkg = basePackage();
  delete pkg.assets.a_shot.gen.inputs.audio;
  pkg.assets.a_shot.gen.direction.voice = {
    mode: 'prompt',
    description: DESCRIPTION,
    seed: VOICE_SEED,
  };
  return pkg;
}

function manifestFor(job, sha256 = SHA) {
  return {
    updatedAt: '2026-10-23T11:55:00.000Z',
    jobs: [{
      job: job.id,
      status: 'succeeded',
      job_id: 'job-vx07-1',
      attempt_id: 'attempt-vx07-1',
      outputs: [{
        relative: job.output,
        sha256,
        bytes: 4096,
        measured: { width: job.dims.width, height: job.dims.height, fps: job.fps, frames: job.frames },
      }],
    }],
  };
}

function apply(pkg, sha256) {
  const doc = planJobs(pkg);
  const job = doc.jobs.find((entry) => entry.id === 'a_shot.plate');
  assert.ok(job, doc.jobs.map((entry) => entry.id).join(', '));
  return { job, result: applyManifestToPackage(pkg, { jobsDoc: doc, manifest: manifestFor(job, sha256) }) };
}

test('a FastH3 plate planned in prompt mode records voicePath prompt', () => {
  const { job, result } = apply(promptPackage());
  assert.equal(job.workflow, FASTH3_NOCLIP_WORKFLOW);
  const asset = result.package.assets.a_shot;
  assert.equal(asset.status, 'ready');
  assert.equal(asset.voicePath, 'prompt');
  assert.equal(asset.media.audio, 'present');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.untouched.length, 0);
});

test('a FastH3 plate planned in clip mode stays unchanged and gets no voicePath', () => {
  const { job, result } = apply(clipPackage());
  assert.equal(job.workflow, 'workflows/fasth3_omni_ref2va.api.json');
  const asset = result.package.assets.a_shot;
  assert.equal(asset.status, 'ready');
  assert.equal(Object.hasOwn(asset, 'voicePath'), false);
  assert.equal(asset.media.audio, 'present');
});

test('prompt voicePath is recorded only on the plate asset the job produced', () => {
  const { result } = apply(promptPackage());
  assert.equal(result.package.assets.a_shot.voicePath, 'prompt');
  assert.equal(Object.hasOwn(result.package.assets.a_person, 'voicePath'), false);
  assert.equal(Object.hasOwn(result.package.assets.a_voice, 'voicePath'), false);
});

test('both applied packages validate against the package schema', () => {
  const prompt = apply(promptPackage()).result.package;
  const promptCheck = validatePackage(prompt);
  assert.equal(promptCheck.schemaOk, true, JSON.stringify(promptCheck.errors));

  const clip = apply(clipPackage()).result.package;
  const clipCheck = validatePackage(clip);
  assert.equal(clipCheck.schemaOk, true, JSON.stringify(clipCheck.errors));
});

test('the schema refuses a voicePath other than prompt', () => {
  for (const voicePath of ['clip', 'upload', 'prompt ']) {
    const pkg = apply(promptPackage()).result.package;
    pkg.assets.a_shot.voicePath = voicePath;
    const check = validatePackage(pkg);
    assert.equal(check.schemaOk, false, `voicePath ${JSON.stringify(voicePath)} was accepted`);
    assert.ok(
      check.errors.some((error) => error.path === '/assets/a_shot/voicePath'),
      JSON.stringify(check.errors),
    );
  }
});
