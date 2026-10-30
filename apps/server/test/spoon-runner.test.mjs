import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { TIMING_REPAIR_TOOL } from '../src/planning-timing-repair.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { planJobs } from '../../../packages/jobs/src/index.mjs';
import { replayProvider } from './fake-provider.mjs';
import { SPOON_BRIEF, SPOON_IDS, SPOON_LABELS, SPOON_LINES, SPOON_PROPOSAL, spoonScenes, SPOON_TIMING } from './fixtures/spoon-files.mjs';

test('frozen five-beat Spoon film completes via fake provider and atomic timing, retaining intentional stills and exact H3 speech', async t => {
  const root = mkdtempSync(join(tmpdir(), 'spoon-runner-'));
  const previousPython = process.env.COMFYRIZZ_PYTHON;
  const executable = join(root, 'local-synth-fixture.mjs');
  // Only the CPU synthesis subprocess is a tone fixture. Normal callback
  // registration, exact-line policy, real ffprobe, persistence/hash and the
  // provider/agent tool transport execute normally. No real TTS or GPU here.
  writeFileSync(executable, `#!${process.execPath}
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv;
const pkg = JSON.parse(readFileSync(args[args.indexOf('--package') + 1], 'utf8'));
if (!${JSON.stringify(SPOON_LINES)}.includes(pkg.scenes[0].narration) || pkg.voice.speed !== 1) throw new Error('Exact natural-speed line was changed');
const out = args[args.indexOf('--out') + 1]; mkdirSync(out, { recursive: true });
const samples = 48000; const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(2000 * Math.sin(i / 10)), 44 + i * 2);
writeFileSync(join(out, 'narration.raw.wav'), wav);
`, { mode: 0o700 });
  process.env.COMFYRIZZ_PYTHON = executable;
  const imageResults = request => request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
    .map(body => body.result ?? body).filter(body => body.asset?.kind === 'image').map(body => body.asset.id);
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief: SPOON_BRIEF, title: 'THE SPOON FILES', proposal: SPOON_PROPOSAL, scenes: spoonScenes().map((scene, index) => index === 3 ? { ...scene, lower_third: { text: 'CASE CLOSED.', start_frame: 75, position: 'bottom' } } : scene) } },
    ...['Fictional office investigator with round glasses and navy cardigan at the break-room table.', 'Open cutlery drawer with one lonely fork and empty spoon-shaped gap.', 'Empty office dishwasher, door open and bare racks.', 'Completely ordinary potted fern in a terracotta pot.', 'Macro silver teaspoon on the break-room table.'].map((subject, i) => ({
      name: 'assets.generate_image', args: { scene_id: SPOON_IDS[[0, 1, 2, 2, 4][i]], intent: subject, placement: 'conditioning', ...(i === 2 || i === 3 ? { aspect: 'panel' } : {}) },
    })),
    request => ({ name: 'storyboard.edit', args: { scene_id: SPOON_IDS[2], patch: {
      media: [2, 3].map((imageIndex, side) => ({ asset: imageResults(request)[imageIndex], label: SPOON_LABELS[side], fit: 'contain' })),
    } } }),
    ...[0, 1, 3, 4].map(index => request => {
      const speaking = index === 0 || index === 3;
      const image = imageResults(request)[speaking ? 0 : index === 1 ? 1 : 4];
      const text = SPOON_LINES[index === 0 ? 0 : 1];
      return { name: 'assets.generate_video', args: { scene_id: SPOON_IDS[index], motion_model: speaking ? 'h3' : 'ltx', image,
        ...(speaking ? { reference: image, dialogue: { text, conditioningText: text, language: 'en-us', voice: 'af_heart', delivery: 'deadpan' } } : {}),
        frames: 193, characterCount: speaking ? 1 : 0,
        subject: speaking ? 'The same fictional office investigator, navy cardigan and round glasses.' : index === 1 ? 'A cutlery drawer with one lonely fork and empty spoon-shaped gap.' : 'A silver teaspoon.',
        composition: 'Photographic natural materials in teal-and-amber office light.', action: speaking ? 'She speaks the exact line, then pauses.' : index === 1 ? 'Dust drifts as the camera tracks into the drawer.' : 'The teaspoon rotates slowly like a priceless artifact.',
        camera: 'Restrained cinematic framing.', soundscape: 'Quiet office room tone.', finishing_sound: 'Quiet utensil and drawer sounds; no music.',
      } };
    }),
  ]);
  t.after(async () => {
    await provider.close();
    if (previousPython === undefined) delete process.env.COMFYRIZZ_PYTHON; else process.env.COMFYRIZZ_PYTHON = previousPython;
    rmSync(root, { recursive: true, force: true });
  });
  const runner = createCpuAgentRunner({ runtimeDir: root, providers: { custom: { baseUrl: provider.url } } });
  const events = [];
  const result = await runner({ brief: SPOON_BRIEF, provider: 'custom', motionModel: 'auto', onEvent: event => {
    events.push(event);
    if (event.type === 'runner_phase' && event.phase === 'repair' && event.status === 'started') provider.setCalls([]);
    if (event.type === 'done' && event.phase === 'repair' && !event.repairKind) provider.setCalls([null, { name: TIMING_REPAIR_TOOL, args: SPOON_TIMING }]);
  } });
  assert.equal(result.live, true); assert.equal(result.fallback, false);
  assert.equal(result.timeline.durationInFrames, 900);
  assert.deepEqual(result.package.scenes.map(scene => scene.id), SPOON_IDS);
  assert.deepEqual(result.package.scenes.map(scene => scene.preferredFrames), SPOON_TIMING.scenes.map(scene => scene.preferredFrames));
  const comparison = result.package.scenes[2];
  assert.deepEqual(comparison.media.map(plate => [plate.label, plate.fit]), SPOON_LABELS.map(label => [label, 'contain']));
  assert.equal(comparison.copy?.headline, undefined);
  for (const plate of comparison.media) {
    const asset = result.package.assets[plate.asset];
    assert.equal(asset.kind, 'image'); assert.equal(asset.gen.generator, 'flux3-klein');
    assert.deepEqual([asset.gen.inputs.width, asset.gen.inputs.height], [960, 1080]);
  }
  for (const [lineIndex, sceneIndex] of [0, 3].entries()) {
    const video = result.package.assets[result.package.scenes[sceneIndex].background.asset];
    const audio = result.package.assets[video.gen.inputs.audio];
    assert.equal(video.gen.generator, 'fasth3-omni');
    assert.equal(video.gen.direction.dialogue.text, SPOON_LINES[lineIndex]);
    assert.equal(audio.gen.inputs.text, SPOON_LINES[lineIndex]);
    assert.equal(audio.gen.inputs.speed, 1); assert.equal(audio.media.durationSeconds, 2);
    assert.equal(result.package.scenes[sceneIndex].narration, undefined);
  }
  assert.equal(validatePackage(result.package).valid, true);
  const jobs = planJobs(result.package).jobs;
  assert.equal(jobs.filter(job => job.generator === 'fasth3-omni').length, 2);
  assert.equal(jobs.filter(job => job.generator === 'ltx25').length, 2);
  assert.equal(jobs.filter(job => comparison.media.some(plate => plate.asset === job.asset)).length, 2);
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === TIMING_REPAIR_TOOL && event.ok));
  assert.equal(events.filter(event => event.type === 'model_result' && event.repairKind === 'exact_timing').length, 3);
  assert.ok(!events.some(event => event.type === 'tool_call' && event.name === 'assets.generate_video' && event.args.scene_id === SPOON_IDS[2]));
});
