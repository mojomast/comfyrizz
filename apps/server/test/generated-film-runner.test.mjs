import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCpuAgentRunner, generatedFilmCompletionProblems } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';

const BRIEF = 'Create a 24-second wordless handcrafted miniature film in 4 shots. A mustard felt jerboa and a cobalt wooden bird restore an island lighthouse at dusk as a small boat approaches. Recurring tactile characters, clear physical action, cinematic camera moves, warm golden payoff, gentle coastal sound. No dialogue, captions, logos or real people.';
const ONE_SHOT_BRIEF = BRIEF.replace('24-second', '6-second').replace('in 4 shots', 'in 1 shot');
const proposal = { logline: 'Two friends restore the lamp.', look: 'Handcrafted dusk miniatures.', soundtrack: 'Coastal sound without speech.' };
const scenes = [1, 2, 3, 4].map(n => ({ id: `shot${n}`, layout: 'hero', preferredFrames: 180, copy: { headline: 'Unwanted headline' } }));
const shotDirection = scene => ({
  scene_id: scene, subject: 'A mustard felt jerboa and cobalt wooden bird.',
  composition: 'Handcrafted island lighthouse at dusk.', action: 'The jerboa hauls the lens while the bird braces it.',
  camera: 'Slow cinematic push.', soundscape: 'Coastal wind and a soft lens click.', characterCount: 2,
  finishing_sound: 'Mix coastal wind and the lens click in finishing.',
});

async function setup(t, calls) {
  const runtimeDir = mkdtempSync(join(new URL('../../../.tmp/', import.meta.url).pathname, 'generated-film-runner-'));
  const provider = await replayProvider(calls);
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { provider, runner, runtimeDir };
}

test('FLUX-only generated-film output is rejected with no scripted fallback', async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes } },
    ...scenes.map((scene, index) => ({ name: 'assets.generate_image', args: { scene_id: scene.id, kind: 'illustration', intent: `FLUX-only shot ${index + 1}`, seed: index + 1 } })),
  ];
  const { provider, runner } = await setup(t, calls);
  await assert.rejects(
    () => runner({ brief: BRIEF, provider: 'custom', motionModel: 'h3' }),
    error => {
      assert.equal(error.code, 'GENERATED_FILM_INCOMPLETE');
      assert.match(error.message, /scene\.media|FLUX stills/);
      return true;
    },
  );
  assert.equal(provider.calls, calls.length + 2, 'one live plan and one bounded repair, never the defaultCpuScript fallback');
});

test('runner accepts real wordless H3 completion and persists silent conditioning', async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes: [scenes[0]] } },
    { name: 'assets.generate_image', args: { scene_id: 'shot1', kind: 'identity-reference', intent: 'Recurring jerboa and bird identity', seed: 11 } },
    { name: 'assets.generate_image', args: { scene_id: 'shot1', kind: 'composition-reference', intent: 'Island lighthouse composition', seed: 12 } },
  ];
  const { runner, runtimeDir, provider } = await setup(t, []);
  // Stable generated image ids are returned by the same deterministic tool. The
  // fake provider cannot discover them ahead of time, so obtain them from a
  // dry tool run through the model is unnecessary: use the IDs computed by the
  // agent's public deterministic script helper below.
  const { createToolset } = await import('../../../packages/agent/dist/src/index.js');
  let draft;
  const tools = createToolset({ generateSvg: () => ({ svg: '<svg/>' }), onPackageChange: pkg => { draft = pkg; } });
  await tools['storyboard.propose'].run(calls[0].args);
  const identity = await tools['assets.generate_image'].run(calls[1].args);
  const composition = await tools['assets.generate_image'].run(calls[2].args);
  provider.setCalls([...calls, { name: 'assets.generate_video', args: { ...shotDirection('shot1'), motion_model: 'h3', image: identity.asset.id, reference: composition.asset.id, wordless: true } }]);
  const events = [];
  let result;
  try {
    result = await runner({ brief: ONE_SHOT_BRIEF, provider: 'custom', motionModel: 'h3', onEvent: event => events.push(event) });
  } catch (error) {
    assert.fail(`${error.message}\n${JSON.stringify(events)}`);
  }
  assert.equal(result.fallback, false, JSON.stringify(events));
  assert.ok(events.some(event => event.type === 'runner_phase' && event.phase === 'initial' && event.status === 'completed'));
  assert.ok(events.some(event => event.type === 'model_result' && typeof event.durationMs === 'number' && typeof event.elapsedMs === 'number'));
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'assets.generate_video' && typeof event.durationMs === 'number'));
  assert.equal(result.package.scenes[0].copy, undefined);
  const video = Object.values(result.package.assets).find(asset => asset.gen?.generator === 'fasth3-omni');
  assert.ok(video);
  const audio = result.package.assets[video.gen.inputs.audio];
  assert.equal(audio.media.durationSeconds, 0.5);
  assert.equal(existsSync(join(runtimeDir, 'packages', audio.file)), true);
  assert.equal(readFileSync(join(runtimeDir, 'packages', audio.file)).length, 24044);
});

test('one bounded repair corrects the existing package duration before production', async t => {
  const badScenes = scenes.map(scene => ({ ...scene, preferredFrames: 225 }));
  const { runner, provider } = await setup(t, [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes: badScenes } },
  ]);
  const repairCalls = [
    ...scenes.map(scene => ({ name: 'storyboard.edit', args: { scene_id: scene.id, patch: { preferredFrames: 180 } } })),
    ...scenes.map(scene => ({ name: 'assets.generate_video', args: { ...shotDirection(scene.id), motion_model: 'klein' } })),
  ];
  let repaired = false;
  const result = await runner({ brief: BRIEF, provider: 'custom', motionModel: 'klein', onEvent: event => {
    if (event.type === 'done' && !repaired) {
      repaired = true;
      provider.setCalls(repairCalls);
    }
  } });
  assert.equal(result.fallback, false);
  assert.equal(repaired, true, 'the invalid first plan really exercised the bounded repair');
  assert.equal(provider.calls, repairCalls.length, 'repair used its step cap only for edits and required shot assets, not another storyboard proposal');
  const repairRequestText = JSON.stringify(provider.requests.at(-1)?.messages ?? []);
  assert.match(repairRequestText, /requested total frames=720/);
  assert.match(repairRequestText, /shot1 preferredFrames=225/);
  assert.match(repairRequestText, /shot2 preferredFrames=225/);
  assert.match(repairRequestText, /Use only these exact scene IDs/);
  const seconds = result.package.scenes.reduce((sum, scene) => sum + scene.preferredFrames, 0) / result.package.format.fps;
  assert.equal(seconds, 24);
  assert.equal(result.package.proposal.logline, proposal.logline);
});

test('completion requires meaningful proposal fields and the requested duration', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const intent = classifyProductionIntent('Create a 20-second wordless film in 4 shots. A cartographer erases a river. No captions.');
  const pkg = {
    proposal: { logline: 'A cartographer erases a river and reflections vanish.', look: 'Woodcut and ink.', soundtrack: 'Paper and dry room tone.' },
    format: { fps: 30 },
    scenes: Array.from({ length: 4 }, (_, index) => ({ id: `shot${index + 1}`, preferredFrames: 225, media: [] })),
    assets: {},
  };
  assert.ok(generatedFilmCompletionProblems(pkg, intent, 'klein').some(problem => problem.includes('20 seconds but the plan is 30.00 seconds')));
  delete pkg.proposal;
  const missing = generatedFilmCompletionProblems(pkg, intent, 'klein');
  assert.ok(missing.some(problem => problem.includes('proposal.logline')));
  assert.ok(missing.some(problem => problem.includes('proposal.look')));
  assert.ok(missing.some(problem => problem.includes('proposal.soundtrack')));
});

test('runner explicitly accepts Klein stills + code motion without H3/LTX jobs', async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes: [scenes[0]] } },
    { name: 'assets.generate_video', args: { ...shotDirection('shot1'), motion_model: 'klein' } },
  ];
  const { runner } = await setup(t, calls);
  const result = await runner({ brief: ONE_SHOT_BRIEF, provider: 'custom', motionModel: 'klein' });
  assert.equal(result.fallback, false);
  assert.match(result.package.compliance.warnings.join(' '), /stills \+ code motion/);
  assert.ok(result.package.scenes[0].motion);
  assert.ok(result.pendingGpu.every(asset => asset.generator === 'flux3-klein'));
  const still = result.package.assets[result.package.scenes[0].media[0].asset];
  assert.equal(still.kind, 'image');
  assert.match(still.notes, /stills \+ code motion/);
  assert.ok(!Object.values(result.package.assets).some(asset => ['fasth3-omni', 'ltx25'].includes(asset.gen?.generator)));
});
