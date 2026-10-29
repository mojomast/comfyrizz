import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyNativeFilmAudio, classifyProductionIntent, createToolset, nativeFilmAudioProblems } from '../../../packages/agent/dist/src/index.js';
import { classifyAudioIntent } from '../../../packages/agent/dist/src/production-intent.js';
import { LAST_SIGNAL_SPEAKING } from '../../../packages/agent/dist/test/fixtures/last-signal.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { planJobs } from '../../../packages/jobs/src/index.mjs';
import { finalizeGeneratedFilmEditorial } from '../src/editorial-finalizer.mjs';
import { editorialBriefProblems, explicitCopyContract, nativeCopyEntries } from '../src/editorial-brief-contract.mjs';
import { generatedFilmCompletionProblems } from '../src/agent-runner.mjs';
import { narrationAudio } from '../../renderer/src/audio-model.js';
import { resolveAudioMix } from '../../renderer/src/audio-mix-model.js';

const intent = classifyProductionIntent(LAST_SIGNAL_SPEAKING);
const line = 'Yesterday, the signal went silent.';
function fixture() {
  return {
    format: { fps: 24 }, voice: { enabled: true, engine: 'kokoro', speed: 0.98 },
    scenes: [
      { id: 'talk', layout: 'title', preferredFrames: 96, copy: { headline: 'THE LAST SIGNAL' }, narration: line, narration_asset: 'conditioning', background: { asset: 'talk' } },
      { id: 'listen', layout: 'title', preferredFrames: 24, copy: { headline: 'THE LAST SIGNAL' }, background: { asset: 'listen' } },
    ],
    assets: {
      talk: { kind: 'video', status: 'ready', file: 'assets/talk.mp4', media: { audio: 'present' }, gen: { generator: 'fasth3-omni', inputs: { audio: 'conditioning' }, direction: { soundscape: 'Room tone.', dialogue: { text: line } } } },
      listen: { kind: 'video', status: 'ready', file: 'assets/listen.mp4', media: { audio: 'present' }, gen: { generator: 'fasth3-omni', direction: { soundscape: 'Quiet room tone.' } } },
      conditioning: { kind: 'audio', status: 'ready', file: 'assets/conditioning.wav', gen: { generator: 'kokoro', inputs: { character: 'mara', text: line, voice: 'af_heart', speed: 1 } } },
    },
  };
}

test('native character speech forbids detached narration and has one natural-speed source route', () => {
  const bad = fixture();
  const problems = nativeFilmAudioProblems(bad, intent);
  assert.ok(problems.some(problem => problem.code === 'NATIVE_DIALOGUE_NARRATOR'));
  assert.ok(problems.some(problem => problem.code === 'NATIVE_DIALOGUE_NARRATION'));
  assert.equal(problems.filter(problem => problem.code === 'NATIVE_AUDIO_MUTED').length, 2);
  const fixed = finalizeGeneratedFilmEditorial(bad, { intent, brief: LAST_SIGNAL_SPEAKING }).package;
  assert.equal(fixed.voice.enabled, false);
  assert.equal(fixed.voice.engine, 'none');
  assert.ok(fixed.scenes.every(scene => !scene.narration && !scene.narration_asset));
  assert.ok(fixed.scenes.every(scene => scene.background.muted === false && scene.background.speed === 1 && scene.background.loop === false));
  assert.deepEqual(fixed.assets, bad.assets, 'conditioning and H3 jobs are not regenerated or rewritten');
  assert.deepEqual(nativeFilmAudioProblems(fixed, intent), []);
  assert.equal(narrationAudio(fixed), null);
  const mix = resolveAudioMix(fixed, { fps: 24, durationInFrames: 120, scenes: [{ id: 'talk', from: 0, durationInFrames: 96 }, { id: 'listen', from: 96, durationInFrames: 24 }] });
  assert.deepEqual(mix.dialogue, [], 'direct native audio is not doubled by the legacy dialogue bus');
  assert.deepEqual(mix.ambience, [], 'direct room tone is not doubled by the legacy ambience bus');
  assert.equal(bad.voice.enabled, true, 'original snapshot untouched');
});

test('conditioning is never standalone narration, even before an audio mix exists', () => {
  const bad = fixture();
  assert.equal(narrationAudio({ assets: bad.assets, scenes: [] }), null);
  assert.equal(narrationAudio(bad), null, 'an accidental conditioning narration_asset cannot become final voiceover');
});

test('explicit separate narrator survives; silence, wordless and master-music policies retain precedence', () => {
  const narrated = classifyProductionIntent('Create a generated film with native character dialogue. Add separate narrator voiceover.');
  const both = applyNativeFilmAudio(fixture(), narrated);
  assert.equal(both.voice.enabled, true);
  assert.equal(both.scenes[0].narration, line);
  assert.equal(both.scenes[0].background.muted, false);
  const silent = finalizeGeneratedFilmEditorial(fixture(), { intent: classifyProductionIntent('Create a completely silent generated film. No audio.') }).package;
  assert.ok(silent.scenes.every(scene => scene.background.muted));
  assert.equal(silent.assets.talk.media.audio, 'muted');
  assert.equal(silent.voice.enabled, false);
  const master = fixture();
  master.audio = { music: { asset: 'song', trim: { startSeconds: 0, endSeconds: 5 } } };
  const wordless = applyNativeFilmAudio(master, classifyProductionIntent('Create a wordless generated film with an uploaded music master.'));
  assert.ok(wordless.scenes.every(scene => scene.background.muted));
  assert.deepEqual(wordless.audio, master.audio);
  assert.ok(nativeFilmAudioProblems(fixture(), classifyProductionIntent('Create a wordless generated film with native room tone.')).some(problem => problem.code === 'NATIVE_WORDLESS_DIALOGUE'));
  const split = fixture();
  split.scenes = [{ id: 'split', layout: 'split', media: [{ asset: 'talk', label: 'Mara' }, { asset: 'listen' }] }];
  const fixed = applyNativeFilmAudio(split, intent);
  assert.equal(fixed.scenes[0].media[0].muted, false);
  assert.equal(fixed.scenes[0].media[1].muted, false);
  assert.equal(fixed.scenes[0].media[0].label, 'Mara');
});

test('Kokoro conditioning and narrator prohibition do not imply detached narration or wordlessness', () => {
  const native = classifyAudioIntent('A character speaks exact dialogue. Use Kokoro for exact-line conditioning. No narration.');
  assert.equal(native.wordless, false);
  assert.equal(native.speechRequested, true);
  assert.equal(native.narrationRequested, false);
  assert.equal(classifyAudioIntent('Use Kokoro voiceover to narrate this film.').narrationRequested, true);
});

test('explicit role-labelled overlays form a closed ordered contract without mining the monologue', () => {
  assert.deepEqual(explicitCopyContract(LAST_SIGNAL_SPEAKING), { items: ['THE LAST SIGNAL', 'MARA VALE', 'THE LAST SIGNAL'], closed: true, ordered: true });
  assert.equal(explicitCopyContract('Mara says "Native editable overlays" and reads an opening title.'), null);
  assert.deepEqual(explicitCopyContract('Native editable overlays: "A SIGNAL" as an opening title and “MARA” as an early lower-third. Bring A SIGNAL back for the final title. No additional words.'), { items: ['A SIGNAL', 'MARA', 'A SIGNAL'], closed: true, ordered: true });
});

test('normal video tools unmute H3 and remove known conditioning overlays while preserving deliberate foreground art', async () => {
  let pkg;
  const tools = createToolset({ motionModel: 'h3', onPackageChange: value => { pkg = value; } });
  await tools['storyboard.propose'].run({ brief: LAST_SIGNAL_SPEAKING, title: 'THE LAST SIGNAL', scenes: [{ id: 's1', layout: 'title', preferredFrames: 150, copy: { headline: 'THE LAST SIGNAL' }, narration: line }] });
  assert.equal(pkg.scenes[0].narration, undefined);
  const identity = (await tools['assets.generate_image'].run({ scene_id: 's1', kind: 'identity-reference', intent: 'Mara at her radio.' })).asset.id;
  const composition = (await tools['assets.generate_image'].run({ scene_id: 's1', kind: 'composition-reference', intent: 'A radio desk at night.' })).asset.id;
  const authored = (await tools['assets.generate_image'].run({ scene_id: 's1', kind: 'illustration', placement: 'foreground', intent: 'An explicitly requested editorial illustration.' })).asset.id;
  await tools['storyboard.edit'].run({ scene_id: 's1', patch: { foreground: [identity, composition, authored].map(asset => ({ asset, x: 0.5, y: 0.5, w: 0.5, anim: 'fade-in' })) } });
  const shot = await tools['assets.generate_video'].run({ scene_id: 's1', image: identity, reference: composition,
    subject: 'Mara at her radio.', composition: 'Her face remains visible.', action: 'She listens quietly.', camera: 'Static.', soundscape: 'Quiet room tone.', characterCount: 1, wordless: true });
  assert.deepEqual(pkg.scenes[0].foreground.map(item => item.asset), [authored]);
  assert.deepEqual(pkg.scenes[0].background, { asset: shot.asset.id, muted: false, loop: false, speed: 1 });
  await tools['storyboard.edit'].run({ scene_id: 's1', patch: { layout: 'split', media_only: false, media: [{ asset: shot.asset.id, muted: false, loop: false, speed: 1 }, { asset: authored, fit: 'contain' }] } });
  assert.equal(pkg.scenes[0].media[0].muted, false);
  assert.equal(pkg.scenes[0].media[0].loop, false);
  assert.equal(pkg.scenes[0].media[0].speed, 1);
  assert.equal(pkg.scenes[0].media[1].fit, 'contain');
});

test('actual frozen UI package is repaired with normal scene edits, preserving 24fps, dialogue bytes and all job plans', {
  skip: !process.env.COMFYRIZZ_SPEAKING_PACKAGE,
}, async () => {
  const original = JSON.parse(readFileSync(process.env.COMFYRIZZ_SPEAKING_PACKAGE, 'utf8'));
  assert.equal(original.id, 'pkg_e06045622625fe13');
  assert.equal(original.revision, 41);
  assert.equal(original.format.fps, 24);
  const before = editorialBriefProblems(original, LAST_SIGNAL_SPEAKING);
  for (const code of ['NATIVE_DIALOGUE_NARRATOR', 'NATIVE_DIALOGUE_NARRATION', 'NATIVE_AUDIO_MUTED', 'BRIEF_COPY_MISMATCH', 'NATIVE_CHARACTER_FOREGROUND_REVIEW']) assert.ok(before.some(problem => problem.code === code), code);
  let fixed = finalizeGeneratedFilmEditorial(original, { intent, brief: LAST_SIGNAL_SPEAKING }).package;
  const tools = createToolset({ initialPackage: fixed, initialIntent: intent, motionModel: 'h3', onPackageChange: pkg => { fixed = pkg; } });
  // Source-contract corrections use the existing supported editorial tool only.
  await tools['storyboard.edit'].run({ scene_id: 's1_desk', patch: { copy: { kicker: '' }, foreground: [] } });
  await tools['storyboard.edit'].run({ scene_id: 's2_name', patch: { layout: 'list', copy: null, media_only: true, lower_third: { text: 'MARA VALE' } } });
  assert.deepEqual(fixed.assets, original.assets, 'all measured conditioning bytes/hash/duration, native dialogue, refs and job definitions survive');
  assert.deepEqual(fixed.format, original.format);
  assert.deepEqual(fixed.duration, original.duration);
  assert.deepEqual(fixed.scenes.map(scene => scene.preferredFrames), original.scenes.map(scene => scene.preferredFrames));
  assert.deepEqual(nativeCopyEntries(fixed).map(entry => entry.text), ['THE LAST SIGNAL', 'MARA VALE', 'THE LAST SIGNAL']);
  assert.deepEqual(editorialBriefProblems(fixed, LAST_SIGNAL_SPEAKING), []);
  assert.deepEqual(generatedFilmCompletionProblems(fixed, intent, 'h3', LAST_SIGNAL_SPEAKING), []);
  assert.equal(validatePackage(fixed).valid, true);
  assert.equal(compileTimeline(fixed).durationInFrames, 1080);
  assert.equal(compileTimeline(fixed).durationInFrames / fixed.format.fps, 45);
  assert.equal(planJobs(fixed).jobs.filter(job => job.generator === 'fasth3-omni').length, 7);
  const mismatched = structuredClone(fixed);
  const spoken = Object.values(mismatched.assets).filter(asset => asset.gen?.generator === 'fasth3-omni' && asset.gen.direction?.dialogue);
  spoken[0].gen.direction.dialogue.text += ' An extra sentence.';
  const secondAudio = mismatched.assets[spoken[1].gen.inputs.audio];
  secondAudio.gen.inputs.voice = 'af_bella';
  const failures = editorialBriefProblems(mismatched, LAST_SIGNAL_SPEAKING);
  for (const code of ['NATIVE_MONOLOGUE_MISMATCH', 'NATIVE_CONDITIONING_MISMATCH', 'NATIVE_CHARACTER_VOICE_CHANGED']) assert.ok(failures.some(problem => problem.code === code), code);
  const thirty = structuredClone(fixed);
  thirty.format.fps = 30; thirty.duration.targetFrames = 1350;
  const windows = [133, 152, 215, 236, 236, 235, 158];
  thirty.scenes.forEach((scene, index) => { scene.preferredFrames = windows[index]; });
  thirty.scenes[0].transitionOut.frames = 15;
  assert.equal(compileTimeline(thirty).durationInFrames, 1350);
  assert.equal(compileTimeline(thirty).durationInFrames / 30, 45);
  assert.deepEqual(nativeFilmAudioProblems(thirty, intent), []);
});
