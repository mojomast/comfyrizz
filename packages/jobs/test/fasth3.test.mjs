// RL12: FastH3 Omni - the experimental reference-conditioned video+audio generator.
//
// The rules this file pins down are the ones that make the generator safe to plan:
//   * its geometry is its own (32-pixel lattice, 17n+5 frames at 24 fps), not LTX's;
//   * its references are identity/context pictures, not a first frame, so no framing lock, no
//     strength and no source-aspect coercion;
//   * the references' *content* is part of the cache key, so a new portrait or voice take
//     invalidates the take;
//   * the produced MP4 keeps the generated audio, and the MiniMax-H3 community licence reaches the
//     output, so the asset is not silently CC0 and not silently redistributable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planJobs, checkJobsDoc } from '../src/plan.mjs';
import { mediaFor, applyManifestToPackage } from '../src/apply.mjs';
import { validatePackage } from '../../schema/src/index.mjs';

const fixture = () => ({
  id: 'pkg_h3test',
  revision: 1,
  format: { width: 1920, height: 1080, fps: 30 },
  scenes: [],
  assets: {
    a_person: { kind: 'image', origin: 'upload', status: 'ready', file: 'refs/person.png', sha256: 'a'.repeat(64), media: { width: 256, height: 512 } },
    a_set: { kind: 'image', origin: 'upload', status: 'ready', file: 'refs/set.png', sha256: 'b'.repeat(64) },
    a_voice: { kind: 'audio', origin: 'upload', status: 'ready', file: 'refs/voice.wav', sha256: 'c'.repeat(64) },
    a_shot: {
      kind: 'video',
      origin: 'generated',
      status: 'pending',
      gen: {
        generator: 'fasth3-omni',
        workflow: 'workflows/fasth3_omni_ref2va.api.json',
        workflow_sha256: 'd'.repeat(64),
        inputs: {
          image: 'a_person',
          reference: 'a_set',
          audio: 'a_voice',
          width: 832,
          height: 480,
          frames: 240,
          fps: 24,
          role: 'background',
          prompt: 'The character says: "Lunch is a feature."',
          seed: 7,
        },
      },
    },
  },
});

function directed() {
  const pkg = fixture();
  pkg.format.fps = 24;
  pkg.scenes = [{ id: 's_one', preferredFrames: 96, background: { asset: 'a_shot', speed: 1 } }];
  pkg.assets.a_voice.media = { durationSeconds: 2.8 };
  pkg.assets.a_shot.gen.direction = {
    subject: 'one armored bear', composition: 'The bear braces a beam with their shoulder.',
    action: 'The beam settles as the bear speaks.', camera: 'Hold a medium close-up.',
    characterCount: 1, soundscape: 'A low engine hum and one metal creak.', reactionSeconds: .5,
    dialogue: { text: 'Roof heavy. Bear expensive.', conditioningText: 'Roof heavy. Bear expensive.',
      language: 'English', voice: 'bear', delivery: 'strained, broken English as written' },
  };
  return pkg;
}

test('structured direction reaches the sampler prompt and cache, not unmapped node params', () => {
  const pkg = directed();
  const doc = planJobs(pkg);
  assert.deepEqual(checkJobsDoc(doc), []);
  const job = doc.jobs[0];
  assert.equal(job.params.direction, undefined);
  assert.match(job.params.prompt, /subject_definitions:[\s\S]*summary:[\s\S]*retention_analysis:[\s\S]*detailed_description:[\s\S]*overall_soundscape:[\s\S]*non_diegetic_music:/);
  assert.match(job.params.prompt, /<Subject 1> \(S1\).*<d>\[English\] Roof heavy\. Bear expensive\.<\/d>/);
  assert.match(job.params.prompt, /within 3\.50 seconds/);
  assert.match(job.params.prompt, /<Audio 1>: reference -/);
  assert.match(job.params.prompt, /first clear appearance of <Subject 1>[\s\S]*without age or design drift: one armored bear/);
  assert.ok(job.params.prompt.split('one armored bear').length - 1 >= 2, 'the identity is repeated in the detailed shot description');
  assert.doesNotMatch(job.params.prompt, /fully_copy/);
  pkg.assets.a_shot.gen.direction.dialogue.delivery = 'quietly threatening';
  assert.notEqual(planJobs(pkg).jobs[0].cacheKey, job.cacheKey);
});

test('preflight catches contaminated conditioning and overfull speech including reactions', () => {
  const pkg = directed();
  pkg.assets.a_shot.gen.direction.dialogue.conditioningText += ' An unrelated line.';
  assert.throws(() => planJobs(pkg), /exact dialogue/);
  pkg.assets.a_shot.gen.direction.dialogue.conditioningText = 'Roof heavy. Bear expensive.';
  pkg.assets.a_voice.media.durationSeconds = 3.8;
  assert.throws(() => planJobs(pkg), /plus reaction time/);
  delete pkg.assets.a_voice.media.durationSeconds;
  assert.throws(() => planJobs(pkg), /measured conditioning/);
});

test('every editorial use limits speech fit, even if source clip is longer', () => {
  const pkg = directed();
  pkg.scenes.push({ id: 's_short', preferredFrames: 48, background: { asset: 'a_shot' } });
  assert.throws(() => planJobs(pkg), /editorial slot/);
  pkg.scenes.pop();
  pkg.scenes[0].background.speed = .5;
  assert.throws(() => planJobs(pkg), /natural-speed/);
  pkg.scenes[0].background.speed = 1;
  pkg.scenes[0].background.trim = { startSeconds: .5 };
  assert.throws(() => planJobs(pkg), /trims after reviewing/);
});

test('offscreen speech does not introduce a visible character in an unoccupied insert', () => {
  const pkg = directed();
  const d = pkg.assets.a_shot.gen.direction;
  Object.assign(d, { subject: 'the cyan console', composition: 'A close insert of three pulse diagrams.', characterCount: 0 });
  assert.throws(() => planJobs(pkg), /offscreen speaker/);
  Object.assign(d.dialogue, { offscreen: true, voice: 'a disembodied computer voice' });
  const prompt = planJobs(pkg).jobs[0].params.prompt;
  assert.match(prompt, /unoccupied throughout/);
  assert.match(prompt, /a disembodied computer voice \(S1\), off-screen says/);
  assert.doesNotMatch(prompt, /<Subject 1> \(S1\) says/);
});

test('legacy prompts remain unchanged and are explicitly unreviewed', () => {
  const pkg = fixture();
  pkg.assets.a_shot.gen.inputs.reference = pkg.assets.a_shot.gen.inputs.image;
  const doc = planJobs(pkg);
  assert.equal(doc.jobs[0].params.prompt, pkg.assets.a_shot.gen.inputs.prompt);
  assert.ok(doc.warnings.some(w => w.code === 'PLAN_H3_DIRECTION_UNREVIEWED'));
  assert.ok(doc.warnings.some(w => w.code === 'PLAN_H3_DUPLICATE_REFERENCE'));
});

test('H3 uses the AV grid, retains prompt, and treats portrait refs as identity not first frame', () => {
  const doc = planJobs(fixture());
  assert.deepEqual(checkJobsDoc(doc), []);
  const [job] = doc.jobs;
  assert.equal(job.generator, 'fasth3-omni');
  assert.equal(job.kind, 'plate');
  assert.deepEqual(job.dims, { width: 832, height: 480 });
  assert.equal(job.frames, 243);
  assert.equal(job.fps, 24);
  assert.equal(job.stage1Dims, undefined);
  assert.equal(job.params.strength, undefined);
  assert.equal(job.params.role, undefined);
  assert.equal(job.params.prompt, fixture().assets.a_shot.gen.inputs.prompt);
  assert.deepEqual(job.fileInputs.map((f) => f.param), ['image', 'reference', 'audio']);
  assert.equal(mediaFor(job).audio, 'present');
});

test('H3 frame counts are the model lattice (17n+5), rounded up', () => {
  const pkg = fixture();
  for (const [requested, expected] of [[240, 243], [192, 192], [5, 5], [6, 22], [362, 362]]) {
    pkg.assets.a_shot.gen.inputs.frames = requested;
    const job = planJobs(pkg).jobs[0];
    assert.equal(job.frames, expected, `requested ${requested}`);
    assert.equal(job.params.frames, expected);
    assert.equal(job.framesAdjusted, expected !== requested);
  }
});

test('H3 dims land on the 32-pixel lattice the graph renders', () => {
  const pkg = fixture();
  pkg.assets.a_shot.gen.inputs.width = 834;
  pkg.assets.a_shot.gen.inputs.height = 481;
  const job = planJobs(pkg).jobs[0];
  assert.deepEqual(job.dims, { width: 832, height: 480 });
  assert.equal(job.dimsAdjusted, true);
});

test('H3 reference content changes invalidate cache even when asset IDs are stable', () => {
  const pkg = fixture();
  const key = planJobs(pkg).jobs[0].cacheKey;
  pkg.assets.a_voice.sha256 = 'e'.repeat(64);
  assert.notEqual(planJobs(pkg).jobs[0].cacheKey, key);
  const portrait = fixture();
  const portraitKey = planJobs(portrait).jobs[0].cacheKey;
  portrait.assets.a_person.sha256 = 'e'.repeat(64);
  assert.notEqual(planJobs(portrait).jobs[0].cacheKey, portraitKey);
});

test('H3 rejects LTX-only or incompatible timing inputs and missing voice', () => {
  for (const [name, value] of [['fps', 30], ['frames', 363], ['frames', NaN], ['upscale', true], ['audio', null], ['image', '']]) {
    const pkg = fixture();
    pkg.assets.a_shot.gen.inputs[name] = value;
    assert.throws(() => planJobs(pkg), /FastH3/, `expected ${name}=${JSON.stringify(value)} to be refused`);
  }
});

test('applied H3 output preserves audio and does not silently assign unrestricted output rights', () => {
  const pkg = fixture();
  const doc = planJobs(pkg);
  const result = applyManifestToPackage(pkg, {
    jobsDoc: doc,
    manifest: {
      jobs: [
        {
          job: 'a_shot.plate',
          status: 'succeeded',
          outputs: [{ relative: 'assets/a_shot.mp4', bytes: 123, sha256: 'f'.repeat(64) }],
        },
      ],
    },
  });
  const asset = result.package.assets.a_shot;
  assert.equal(asset.media.audio, 'present');
  assert.equal(asset.model_license.id, 'LicenseRef-MiniMax-H3-Community');
  assert.equal(asset.license.id, 'LicenseRef-MiniMax-H3-Community');
  assert.equal(asset.redistributable, false);
});

test('H3 generator and model-specific defaults validate in the package schema', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../schema/fixtures/valid/minimal.json', import.meta.url)));
  Object.assign(pkg.assets, directed().assets);
  for (const asset of Object.values(pkg.assets)) {
    if (asset.origin !== 'upload') continue;
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
  assert.equal(graph['15'].inputs.scheduler, 'simple');
  assert.equal(graph['14'].inputs.sampler_name, 'euler');
  assert.equal(graph['12'].class_type, 'BasicGuider');
  assert.equal(graph['11'].inputs.selection, 'vsa');
  assert.equal(graph['11'].inputs['selection.keep_percent'], 10);
  assert.equal(graph['9'].inputs.shift_video, 12);
  assert.equal(graph['9'].inputs.shift_audio, 3);
  assert.deepEqual(graph['19'].inputs.audio, ['18', 0]);
  assert.equal(graph['18'].class_type, 'VAEDecodeAudio');
  assert.equal(graph['19'].inputs.fps, 24);
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value)) assert.ok(graph[value[0]], `unresolved graph link ${value}`);
    }
  }
});

test('the params map points at real node inputs of the FastH3 graph', () => {
  const graph = JSON.parse(readFileSync(new URL('../../../workflows/fasth3_omni_ref2va.api.json', import.meta.url)));
  const map = JSON.parse(readFileSync(new URL('../../../workflows/fasth3_omni_ref2va.api.params.json', import.meta.url)));
  assert.equal(map.generator, 'fasth3-omni');
  assert.deepEqual(map.files, ['image', 'reference', 'audio']);
  for (const [name, target] of Object.entries(map.map)) {
    // one target ("5", "image") or several ([...], [...])
    const targets = Array.isArray(target[0]) ? target : [target];
    for (const [nodeId, field] of targets) {
      assert.ok(graph[nodeId], `${name} -> missing node ${nodeId}`);
      assert.ok(field in graph[nodeId].inputs, `${name} -> ${nodeId}.${field} is not an input`);
    }
  }
});
