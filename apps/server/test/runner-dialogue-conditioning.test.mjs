import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCpuAgentRunner, generatedFilmCompletionProblems } from '../src/agent-runner.mjs';
import { classifyProductionIntent } from '../../../packages/agent/dist/src/index.js';
import { replayProvider } from './fake-provider.mjs';
import { planJobs } from '../../../packages/jobs/src/index.mjs';

const LINE = 'Yesterday, the signal went silent.';

test('server runner registers local exact-line conditioning through the provider/tool pipeline', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runner-dialogue-'));
  const previousPython = process.env.COMFYRIZZ_PYTHON;
  // Fixture for the local synthesis subprocess only. The runner, tool callback,
  // WAV persistence, actual ffprobe, hashing and H3 job planning are production
  // code. A tone fixture does not represent generated speech or lip-sync quality.
  const executable = join(root, 'local-synth-fixture.mjs');
  writeFileSync(executable, `#!${process.execPath}
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv;
const pkg = JSON.parse(readFileSync(args[args.indexOf('--package') + 1], 'utf8'));
if (pkg.scenes[0].narration !== ${JSON.stringify(LINE)} || pkg.voice.speed !== 1) throw new Error('Exact natural-speed line was changed');
const out = args[args.indexOf('--out') + 1];
mkdirSync(out, { recursive: true });
const samples = 48000;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(2000 * Math.sin(i / 10)), 44 + i * 2);
writeFileSync(join(out, 'narration.raw.wav'), wav);
`, { mode: 0o700 });
  process.env.COMFYRIZZ_PYTHON = executable;
  const brief = `Create exactly 6 seconds of landscape generated film in one shot. A fictional adult radio archivist says exactly "${LINE}" in English, with synchronized native H3 dialogue and quiet room tone. No music, captions, logos or real people.`;
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief, title: 'The Last Signal',
      proposal: { logline: 'A fictional radio archivist remembers the silent signal.', look: 'Photographic teal and amber night.', soundtrack: 'Exact native speech with quiet room tone; no music.' },
      scenes: [{ id: 's1', layout: 'list', media_only: true, preferredFrames: 180 }],
    } },
    { name: 'assets.generate_image', args: { scene_id: 's1', kind: 'identity-reference', intent: 'A fictional adult radio archivist with dark curly hair.' } },
    { name: 'assets.generate_image', args: { scene_id: 's1', kind: 'composition-reference', intent: 'A radio archive at night, face and mouth clearly visible, teal and amber lighting.' } },
    request => {
      const images = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
        .map(body => body.result ?? body).filter(body => body.asset?.kind === 'image');
      return { name: 'assets.generate_video', args: {
        scene_id: 's1', motion_model: 'h3', image: images[0].asset.id, reference: images[1].asset.id,
        subject: 'A fictional adult radio archivist with dark curly hair.', composition: 'Medium close view at the radio desk, mouth visible.',
        action: 'She speaks the exact line then listens.', camera: 'Static medium close view.', soundscape: 'Quiet room tone and analog radio hiss.', characterCount: 1,
        dialogue: { text: LINE, conditioningText: LINE, language: 'en-us', voice: 'af_heart', delivery: 'quietly, with unease' },
      } };
    },
  ]);
  t.after(async () => {
    await provider.close();
    if (previousPython === undefined) delete process.env.COMFYRIZZ_PYTHON;
    else process.env.COMFYRIZZ_PYTHON = previousPython;
    rmSync(root, { recursive: true, force: true });
  });
  const run = createCpuAgentRunner({ runtimeDir: root, providers: { custom: { baseUrl: provider.url } } });
  const result = await run({ brief, provider: 'custom', motionModel: 'h3' });
  const pkg = result.package;
  const video = pkg.assets[pkg.scenes[0].background.asset];
  const audio = pkg.assets[video.gen.inputs.audio];
  assert.equal(audio.status, 'ready');
  assert.equal(audio.media.durationSeconds, 2);
  assert.equal(audio.gen.inputs.text, LINE);
  assert.equal(audio.gen.inputs.speed, 1);
  assert.equal(audio.sha256, createHash('sha256').update(readFileSync(join(root, 'packages', audio.file))).digest('hex'));
  assert.equal(video.gen.direction.dialogue.text, LINE);
  assert.equal(video.status, 'pending');
  assert.equal(pkg.voice.enabled, false);
  assert.equal(pkg.scenes[0].narration, undefined);
  assert.equal(result.timeline.durationInFrames, 180);
  assert.ok(pkg.scenes[0].preferredFrames >= Math.ceil((audio.media.durationSeconds + 0.2) * pkg.format.fps));
  assert.ok(planJobs(pkg).jobs.some(job => job.asset === pkg.scenes[0].background.asset && job.generator === 'fasth3-omni'));
  assert.ok(result.events.some(event => event.name === 'assets.generate_video' && event.ok));
  const tooShort = structuredClone(pkg);
  tooShort.scenes[0].preferredFrames = 60;
  assert.ok(generatedFilmCompletionProblems(tooShort, classifyProductionIntent(brief), 'h3', brief)
    .some(problem => /measured native dialogue needs at least 66 project frames/.test(problem)), 'ordinary scene edits cannot bypass the measured natural-speech floor');
});
