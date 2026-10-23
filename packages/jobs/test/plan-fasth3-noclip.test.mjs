// VX05: FastH3 prompt-voice planning (no-clip graph).
//
// A prompt voice is a text description plus a pinned uint32 seed on
// gen.direction.voice. In prompt mode the planner:
//   * selects workflows/fasth3_omni_ref2v_noclip.api.json and its committed hash;
//   * requires no audio input (and refuses a stray one);
//   * embeds the description byte-for-byte and quotes the exact line;
//   * estimates speech at words / 2.5 seconds and checks it against the editorial slot;
//   * folds {voiceDescription, seed} into castRef instead of the audio hash.
// Clip mode (the default, including an absent voice) must stay byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  planJobs,
  checkJobsDoc,
  cacheKeyFor,
  canonical,
  sha256Hex,
} from '../src/plan.mjs';

const NOCLIP_WORKFLOW = 'workflows/fasth3_omni_ref2v_noclip.api.json';
const NOCLIP_SHA256 = createHash('sha256')
  .update(readFileSync(new URL(`../../../${NOCLIP_WORKFLOW}`, import.meta.url)))
  .digest('hex');
const DESCRIPTION = 'Warm, low narrator; unhurried (never imitates anyone).';
const VOICE_SEED = 314159;

function basePackage() {
  return {
    id: 'pkg_vx05',
    revision: 1,
    format: { width: 1920, height: 1080, fps: 24 },
    scenes: [{ id: 's1', preferredFrames: 96, background: { asset: 'shot', speed: 1 } }],
    assets: {
      person: {
        kind: 'image', origin: 'upload', status: 'ready',
        file: 'refs/person.png', sha256: 'a'.repeat(64),
      },
      set: {
        kind: 'image', origin: 'upload', status: 'ready',
        file: 'refs/set.png', sha256: 'b'.repeat(64),
      },
      voice: {
        kind: 'audio', origin: 'upload', status: 'ready',
        file: 'refs/voice.wav', sha256: 'c'.repeat(64), media: { durationSeconds: 2.8 },
      },
      shot: {
        kind: 'video', origin: 'generated', status: 'pending',
        gen: {
          generator: 'fasth3-omni',
          workflow: 'workflows/fasth3_omni_ref2va.api.json',
          workflow_sha256: 'd'.repeat(64),
          inputs: {
            image: 'person', reference: 'set', audio: 'voice',
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
  };
}

function clipPackage() {
  return basePackage();
}

function promptPackage() {
  const pkg = basePackage();
  delete pkg.assets.shot.gen.inputs.audio;
  pkg.assets.shot.gen.direction.voice = {
    mode: 'prompt',
    description: DESCRIPTION,
    seed: VOICE_SEED,
  };
  return pkg;
}

function castRefFor(description, seed) {
  return sha256Hex(canonical([
    { name: 'image', asset: 'person', sha256: 'a'.repeat(64) },
    { name: 'reference', asset: 'set', sha256: 'b'.repeat(64) },
    { voiceDescription: description, seed },
  ]));
}

test('clip mode stays byte-identical to the pre-VX05 golden', () => {
  const doc = planJobs(clipPackage());
  assert.deepEqual(checkJobsDoc(doc), []);
  assert.equal(doc.hash, '3a7bbbfc2147e9aa845cd2428a353784fc781b0281094546cfefa65b672b4971');
  const job = doc.jobs[0];
  assert.equal(job.workflow, 'workflows/fasth3_omni_ref2va.api.json');
  assert.equal(job.workflowSha256, 'd'.repeat(64));
  assert.equal(job.cacheKey, 'd98867cbad26830522afb801fcaa61c2734b3dce31dc0c3ac60d565e0f070c35');
  assert.equal(sha256Hex(job.params.prompt), 'cb10fcea97cfded8703df2ad75db7d61d35228a9ff3e0d86542a0a1b48629b65');
});

test('prompt mode selects the no-clip template and its committed hash', () => {
  const pkg = promptPackage();
  const doc = planJobs(pkg);
  assert.deepEqual(checkJobsDoc(doc), []);
  const job = doc.jobs[0];
  assert.equal(job.workflow, NOCLIP_WORKFLOW);
  assert.equal(job.workflowSha256, NOCLIP_SHA256);
  assert.equal(job.params.audio, undefined);
  assert.deepEqual(job.fileInputs.map((entry) => entry.param), ['image', 'reference']);
});

test('clip mode still requires the audio clip', () => {
  const pkg = clipPackage();
  delete pkg.assets.shot.gen.inputs.audio;
  assert.throws(() => planJobs(pkg), /FastH3 template requires audio/);
});

test('prompt mode needs no audio clip and refuses a stray audio input', () => {
  const silent = promptPackage();
  const job = planJobs(silent).jobs[0];
  assert.equal(job.seed, VOICE_SEED);
  assert.equal(job.params.seed, VOICE_SEED);
  assert.equal(job.seed, silent.assets.shot.gen.direction.voice.seed);

  const stray = promptPackage();
  stray.assets.shot.gen.inputs.audio = 'voice';
  assert.throws(() => planJobs(stray), /PLAN_H3_PROMPT_HAS_AUDIO/);
});

test('prompt mode embeds the description byte-for-byte and quotes the line', () => {
  const job = planJobs(promptPackage()).jobs[0];
  assert.ok(job.params.prompt.includes(DESCRIPTION), 'the description must appear exactly');
  assert.ok(job.params.prompt.includes(`voice:\n${DESCRIPTION}`), 'a fixed voice section carries the description');
  assert.ok(job.params.prompt.includes('"Roof heavy. Bear expensive."'), 'the exact line is quoted');
  assert.doesNotMatch(job.params.prompt, /<Audio 1>/);
  assert.doesNotMatch(job.params.prompt, /<d>|<\/d>/);
});

test('prompt mode estimates speech at words / 2.5 against the editorial slot', () => {
  const fits = promptPackage();
  fits.scenes[0].preferredFrames = 48; // 2.0 s at the package fps
  Object.assign(fits.assets.shot.gen.direction.dialogue, {
    text: 'One two three four five',
    conditioningText: 'One two three four five',
  });
  fits.assets.shot.gen.direction.reactionSeconds = 0;
  assert.equal(planJobs(fits).jobs[0].params.prompt.includes('"One two three four five"'), true);

  const overfull = promptPackage();
  overfull.scenes[0].preferredFrames = 48;
  Object.assign(overfull.assets.shot.gen.direction.dialogue, {
    text: 'One two three four five six',
    conditioningText: 'One two three four five six',
  });
  overfull.assets.shot.gen.direction.reactionSeconds = 0;
  assert.throws(() => planJobs(overfull), /plus reaction time/);
});

test('prompt mode castRef uses {voiceDescription, seed} instead of the audio hash', () => {
  const pkg = promptPackage();
  const job = planJobs(pkg).jobs[0];
  const refSha256 = castRefFor(DESCRIPTION, VOICE_SEED);
  assert.equal(
    job.cacheKey,
    cacheKeyFor({
      workflowSha256: NOCLIP_SHA256,
      generator: 'fasth3-omni',
      model: null,
      modelRevision: null,
      params: job.params,
      seed: VOICE_SEED,
      width: 832,
      height: 480,
      frames: 107,
      refSha256,
    }),
  );

  const newDescription = promptPackage();
  newDescription.assets.shot.gen.direction.voice.description = 'Bright, quick narrator with a dry edge.';
  const descriptionJob = planJobs(newDescription).jobs[0];
  assert.notEqual(descriptionJob.cacheKey, job.cacheKey);
  assert.equal(
    descriptionJob.cacheKey,
    cacheKeyFor({
      workflowSha256: NOCLIP_SHA256,
      generator: 'fasth3-omni',
      model: null,
      modelRevision: null,
      params: descriptionJob.params,
      seed: VOICE_SEED,
      width: 832,
      height: 480,
      frames: 107,
      refSha256: castRefFor('Bright, quick narrator with a dry edge.', VOICE_SEED),
    }),
  );

  const newSeed = promptPackage();
  newSeed.assets.shot.gen.direction.voice.seed = VOICE_SEED + 1;
  const seedJob = planJobs(newSeed).jobs[0];
  assert.notEqual(seedJob.cacheKey, job.cacheKey);
  assert.equal(seedJob.seed, VOICE_SEED + 1);
  assert.equal(
    seedJob.cacheKey,
    cacheKeyFor({
      workflowSha256: NOCLIP_SHA256,
      generator: 'fasth3-omni',
      model: null,
      modelRevision: null,
      params: seedJob.params,
      seed: VOICE_SEED + 1,
      width: 832,
      height: 480,
      frames: 107,
      refSha256: castRefFor(DESCRIPTION, VOICE_SEED + 1),
    }),
  );
});

test('prompt mode without a description refuses instead of falling back to clip', () => {
  const pkg = promptPackage();
  delete pkg.assets.shot.gen.direction.voice.description;
  assert.throws(() => planJobs(pkg), /PLAN_H3_NO_VOICE_DESCRIPTION/);
});
