import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDialogueConditioner } from '../src/dialogue-conditioning.mjs';
import { createKokoroSynth } from '../src/characters/kokoro-synth.mjs';
import { createScriptedModel, createToolset, runCpuSlice } from '../../../packages/agent/dist/src/index.js';
import { planJobs } from '../../../packages/jobs/src/index.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { LAST_SIGNAL_SPEAKING } from '../../../packages/agent/dist/test/fixtures/last-signal.js';

const LINE = 'Yesterday, the signal went silent.';
const request = { text: LINE, language: 'en-us', voice: 'af_heart', character: 'mara' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const BRIEF = LAST_SIGNAL_SPEAKING;

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'h3-dialogue-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function wav(seconds = 1) {
  const samples = Math.round(seconds * 24000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(2000 * Math.sin(i / 10)), 44 + i * 2);
  return bytes;
}

function fakeLocalSynth(root, { seconds = 1, calls = [], runCommand } = {}) {
  return createKokoroSynth({
    cacheDir: join(root, 'synth-cache'), timeoutMs: 5000, maxTextChars: 2000, preserveText: true,
    runCommand: runCommand ?? (async (_file, args, options) => {
      const pkg = JSON.parse(readFileSync(args[args.indexOf('--package') + 1], 'utf8'));
      calls.push({ pkg, options });
      const out = args[args.indexOf('--out') + 1];
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'narration.raw.wav'), wav(seconds));
      return { stdout: '', stderr: '' };
    }),
  });
}

async function draftTools(prepareDialogueAudio) {
  let pkg;
  const tools = createToolset({ motionModel: 'h3', prepareDialogueAudio, onPackageChange: value => { pkg = value; } });
  await tools['storyboard.propose'].run({ brief: BRIEF, title: 'The Last Signal',
    proposal: { logline: 'A radio archivist hears tomorrow.', look: 'Atmospheric teal and amber.', soundtrack: 'Native room tone and exact character speech.' },
    scenes: Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, layout: 'hero', preferredFrames: 150,
      ...(i === 0 || i === 8 ? { copy: { headline: 'THE LAST SIGNAL' } } : {}),
      ...(i === 1 ? { lower_third: { text: 'MARA VALE' } } : {}),
    })),
  });
  const identity = await tools['assets.generate_image'].run({ scene_id: 's1', kind: 'identity-reference', intent: 'Mara Vale, adult radio archivist with dark curly bob and charcoal overshirt.' });
  const composition = await tools['assets.generate_image'].run({ scene_id: 's1', kind: 'composition-reference', intent: 'Analog radio desk at night, atmospheric teal and amber.' });
  const direction = {
    scene_id: 's1', motion_model: 'h3', image: identity.asset.id, reference: composition.asset.id,
    subject: 'Mara Vale, adult radio archivist with dark curly bob and charcoal overshirt.',
    composition: 'Medium close view of Mara at the analog radio desk, her face and mouth visible.',
    action: 'She turns the tuning knob and speaks, then listens.', camera: 'Static medium close view.',
    soundscape: 'Quiet room tone and analog radio hiss.', characterCount: 1,
    dialogue: { text: LINE, conditioningText: LINE, language: 'en-us', voice: 'af_heart', delivery: 'quietly, with unease' },
  };
  return { tools, direction, getPackage: () => pkg };
}

test('registered CPU planning flow automatically conditions nine H3 jobs, preserving exact monologue, overlays and 45s', async t => {
  const root = workspace(t);
  const calls = [];
  const prepareDialogueAudio = createDialogueConditioner({ assetsDir: join(root, 'assets'), synth: fakeLocalSynth(root, { calls }) });
  const { direction, getPackage } = await draftTools(prepareDialogueAudio);
  const lines = [
    'Every night, this radio receives a message from tomorrow.', 'Tonight, it said my name.',
    'At first, I thought someone was playing a trick.', 'Then it described a storm before the sky turned dark.',
    'I started writing everything down: the times, the voices, the places nobody should have known.', LINE,
    'For the first time in months, I slept.', 'But a minute ago, the radio switched itself on.',
    'And this time, the voice on the other end sounded exactly like me.',
  ];
  const slice = await runCpuSlice({ brief: BRIEF, motionModel: 'h3', initialPackage: getPackage(), prepareDialogueAudio,
    model: createScriptedModel(lines.map((text, i) => ({ name: 'assets.generate_video', args: {
      ...direction, scene_id: `s${i + 1}`, dialogue: { ...direction.dialogue, text, conditioningText: text },
    } }))),
  });
  assert.equal(slice.ok, true, JSON.stringify(slice.result));
  const pkg = slice.package;
  assert.equal(pkg.scenes.reduce((total, scene) => total + scene.preferredFrames, 0), 1350);
  assert.equal(pkg.voice.enabled, false);
  assert.ok(pkg.scenes.every(scene => !scene.narration && !scene.narration_asset));
  assert.equal(pkg.audio?.narration, undefined);
  assert.equal(pkg.scenes[0].copy.headline, 'THE LAST SIGNAL');
  assert.equal(pkg.scenes[1].lower_third.text, 'MARA VALE');
  assert.equal(pkg.scenes[8].copy.headline, 'THE LAST SIGNAL');
  assert.deepEqual(calls.map(call => call.pkg.scenes[0].narration), lines);
  assert.ok(calls.every(call => call.pkg.voice.speed === 1 && call.pkg.voice.voice === 'af_heart'));
  const valid = validatePackage(pkg);
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  const jobs = planJobs(pkg).jobs.filter(job => job.generator === 'fasth3-omni');
  assert.equal(jobs.length, 9);
  for (const scene of pkg.scenes) {
    const video = pkg.assets[scene.background.asset];
    const audio = pkg.assets[video.gen.inputs.audio];
    assert.equal(video.status, 'pending');
    assert.equal(audio.status, 'ready');
    assert.equal(audio.gen.inputs.text, video.gen.direction.dialogue.text);
    assert.equal(audio.media.durationSeconds, 1);
    assert.equal(audio.sha256, sha(readFileSync(join(root, audio.file))));
    assert.ok(jobs.some(job => job.fileInputs.some(input => input.param === 'audio' && input.path.endsWith(audio.file))));
  }
});

test('natural speech exceeding its slot retains measured conditioning for targeted timing repair, never plans video', async t => {
  const root = workspace(t);
  const prepare = createDialogueConditioner({ assetsDir: join(root, 'assets'), synth: fakeLocalSynth(root, { seconds: 5.1 }) });
  const { tools, direction, getPackage } = await draftTools(prepare);
  await assert.rejects(() => tools['assets.generate_video'].run(direction), error => {
    assert.equal(error.code, 'DIALOGUE_AUDIO_TOO_LONG');
    assert.equal(error.requiredFrames, 159);
    assert.match(error.message, /preserving every exact word/);
    return true;
  });
  const pkg = getPackage();
  const conditioning = Object.values(pkg.assets).find(asset => asset.gen?.generator === 'kokoro');
  assert.equal(conditioning.gen.inputs.text, LINE);
  assert.equal(conditioning.media.durationSeconds, 5.1);
  assert.ok(!Object.values(pkg.assets).some(asset => asset.kind === 'video'));
});

test('mismatched exact text and LTX substitution fail before any local synthesis', async t => {
  const root = workspace(t);
  const calls = [];
  const prepare = createDialogueConditioner({ assetsDir: join(root, 'assets'), synth: fakeLocalSynth(root, { calls }) });
  const { tools, direction } = await draftTools(prepare);
  assert.throws(() => tools['assets.generate_video'].run({ ...direction,
    dialogue: { ...direction.dialogue, conditioningText: 'The signal stopped.' },
  }), /must exactly match/);
  assert.throws(() => tools['assets.generate_video'].run({ ...direction, motion_model: 'ltx' }), /conflicts/);
  assert.equal(calls.length, 0);
});

test('recurring identity retains its resolved voice across new lines and repair toolsets', async t => {
  const root = workspace(t);
  const calls = [];
  const make = () => createDialogueConditioner({ assetsDir: join(root, 'assets'), synth: fakeLocalSynth(root, { calls }) });
  const first = await make()({ ...request, voice: 'af_bella' });
  const resumed = make();
  const second = await resumed({ ...request, text: 'For the first time in months, I slept.',
    voice: 'same quiet female voice', previousVoice: first.asset.gen.inputs.voice,
  });
  const third = await resumed({ ...request, text: 'Tonight, it said my name.', voice: 'quiet female voice' });
  assert.notEqual(first.id, second.id);
  assert.equal(second.asset.gen.inputs.voice, 'af_bella');
  assert.equal(third.asset.gen.inputs.voice, 'af_bella');
  assert.ok(calls.every(call => call.pkg.voice.speed === 1 && call.pkg.voice.voice === 'af_bella'));
});

test('server rejects changed bytes, fabricated paths/text/duration and changed recurring voice', async t => {
  const root = workspace(t);
  const prepare = createDialogueConditioner({ assetsDir: join(root, 'assets'), synth: fakeLocalSynth(root) });
  const ready = await prepare(request);
  assert.equal((await prepare({ ...request, existing: ready })).asset.sha256, ready.asset.sha256);
  for (const asset of [
    { ...ready.asset, file: '../escape.wav' },
    { ...ready.asset, gen: { ...ready.asset.gen, inputs: { ...ready.asset.gen.inputs, text: 'Changed line.' } } },
  ]) await assert.rejects(() => prepare({ ...request, existing: { id: ready.id, asset } }), { code: 'DIALOGUE_AUDIO_PROVENANCE' });
  await assert.rejects(() => prepare({ ...request, existing: { ...ready, asset: { ...ready.asset, media: { durationSeconds: 9 } } } }), { code: 'DIALOGUE_AUDIO_DURATION' });
  await assert.rejects(() => prepare({ ...request, voice: 'am_michael' }), { code: 'DIALOGUE_VOICE_CHANGED' });
  const target = join(root, ready.asset.file);
  writeFileSync(target, wav(2));
  await assert.rejects(() => prepare({ ...request, existing: ready }), { code: 'DIALOGUE_AUDIO_HASH' });
  rmSync(target);
  const outside = join(root, 'outside.wav'); writeFileSync(outside, wav()); symlinkSync(outside, target);
  await assert.rejects(() => prepare({ ...request, existing: ready }), { code: 'DIALOGUE_AUDIO_PATH' });
});

test('synthesis/hash/probe failures never register a ready asset and clean owned partial WAVs', async t => {
  for (const failure of ['synthesis', 'hash', 'probe']) {
    const root = workspace(t);
    const synth = fakeLocalSynth(root);
    const prepare = createDialogueConditioner({ assetsDir: join(root, 'assets'), synth: async input => {
      if (failure === 'synthesis') throw new Error('Kokoro runtime unavailable');
      const result = await synth(input);
      if (failure === 'hash') result.sha256 = '0'.repeat(64);
      return result;
    }, ...(failure === 'probe' ? { runCommand: async () => { throw new Error('probe failed'); } } : {}) });
    const { tools, direction, getPackage } = await draftTools(prepare);
    await assert.rejects(() => tools['assets.generate_video'].run(direction), /unavailable|sha256|probe failed/);
    assert.ok(!Object.values(getPackage().assets).some(asset => asset.kind === 'audio' || asset.kind === 'video'));
    assert.deepEqual(readdirSync(join(root, 'assets')), []);
  }
});

test('timeout/cancellation abort local synthesis, bound an uncooperative callback and remove work dirs', async t => {
  for (const cancellation of [false, true]) {
    const root = workspace(t);
    const controller = new AbortController();
    let childSignal;
    const synth = fakeLocalSynth(root, { runCommand: async (_file, _args, options) => {
      childSignal = options.signal;
      return new Promise(() => {});
    } });
    const prepare = createDialogueConditioner({ assetsDir: join(root, 'assets'), synth, timeoutMs: cancellation ? 5000 : 30 });
    const pending = prepare({ ...request, signal: controller.signal });
    if (cancellation) controller.abort(new Error('cancelled by caller'));
    await assert.rejects(() => pending, cancellation ? /cancelled by caller/ : /exceeded/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(childSignal.aborted, true);
    assert.ok(readdirSync(join(root, 'synth-cache')).every(name => !name.startsWith('.work-')));
    assert.deepEqual(readdirSync(join(root, 'assets')), []);
  }
});

test('real offline Kokoro line passes registered H3 tool and actual media probe (opt-in)', {
  skip: process.env.COMFYRIZZ_TEST_DIALOGUE_TTS !== '1', timeout: 100000,
}, async t => {
  const root = workspace(t);
  const prepare = createDialogueConditioner({ assetsDir: join(root, 'assets'), timeoutMs: 90000 });
  const { tools, direction, getPackage } = await draftTools(prepare);
  const result = await tools['assets.generate_video'].run(direction);
  const pkg = getPackage();
  const audio = pkg.assets[result.asset.gen.inputs.audio];
  assert.ok(existsSync(join(root, audio.file)));
  assert.equal(audio.sha256, sha(readFileSync(join(root, audio.file))));
  assert.equal(audio.gen.inputs.text, LINE);
  assert.ok(audio.media.durationSeconds > 0.5 && audio.media.durationSeconds < 4.8);
  assert.equal(result.asset.gen.generator, 'fasth3-omni');
  assert.equal(result.requires_approval, 'spend');
  assert.equal(pkg.voice.enabled, false);
  assert.ok(planJobs(pkg).jobs.some(job => job.asset === result.asset.id));
  t.diagnostic(JSON.stringify({ text: LINE, voice: audio.gen.inputs.voice, sha256: audio.sha256, bytes: audio.bytes, media: audio.media, nativeH3: true, gpuExecuted: false }));
});
