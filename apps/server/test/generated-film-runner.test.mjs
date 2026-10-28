import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { coverGeneratedFilmScenes, createCpuAgentRunner, enforceLiveActionHumans, generatedFilmCompletionProblems } from '../src/agent-runner.mjs';
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

test('incomplete live motion graphics reaches the deterministic CPU fallback', async t => {
  const brief = 'A calm product launch video with a check icon, flow diagram, dot pattern and animated bars.';
  const calls = [
    { name: 'storyboard.propose', args: { brief, title: 'Calm launch' } },
  ];
  const { provider, runner } = await setup(t, calls);
  const result = await runner({ brief, provider: 'custom' });
  assert.equal(result.fallback, true);
  assert.equal(result.svgAssets.length, 4);
  assert.equal(result.pendingGpu.length, 1);
  assert.equal(result.package.scenes.length, 6);
  assert.equal(provider.calls, calls.length + 1, 'fallback planning is local and spends no more provider tokens');
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
  assert.ok(result.usage.total > 0);
  assert.equal(result.usage.total, result.usage.input + result.usage.output);
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

test('live-action recovery rewrites clay styling instead of looping on validation', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const original = {
    title: 'Six Clay Wipeouts', revision: 4,
    proposal: { logline: 'Clay skaters fall.', look: 'Plasticine stop-motion.', soundtrack: 'Clay clatter.' },
    format: { fps: 30 },
    scenes: [{ id: 's1', preferredFrames: 150, media: [] }],
    assets: {
      a_img: { kind: 'image', gen: { generator: 'flux3-klein', inputs: { prompt: 'A handmade clay figure in a tabletop skate park.' } } },
    },
  };
  const corrected = enforceLiveActionHumans(original);
  assert.equal(corrected.changed, true);
  assert.match(corrected.package.proposal.look, /Photorealistic live-action humans/);
  assert.ok(corrected.package.proposal.look.length <= 100);
  assert.match(corrected.package.assets.a_img.gen.inputs.prompt, /^Photorealistic live-action fictional human adults/);
  assert.doesNotMatch(JSON.stringify(corrected.package), /clay|plasticine|stop-motion/i);
  assert.match(original.proposal.look, /Plasticine/);
  const intent = classifyProductionIntent('Create a live-action film with real humans.');
  const problems = generatedFilmCompletionProblems(corrected.package, intent, 'auto');
  assert.equal(problems.some(problem => problem.includes('real-human brief conflicts')), false, problems.join('\n'));
});

test('coverage splitter creates separate short generation shots while preserving duration', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const pkg = {
    title: 'Real Human Skaters',
    proposal: { logline: 'A skater falls.', look: 'Photorealistic live-action humans.', soundtrack: 'Foley.' },
    format: { fps: 30 }, revision: 20,
    scenes: [{ id: 's1', preferredFrames: 600, media: [{ asset: 'a_vid_old' }], notes: 'LTX finishing sound plan: foley' }],
    assets: {
      a_vid_old: {
        kind: 'video', status: 'pending',
        gen: {
          generator: 'ltx25', workflow: 'workflows/ltx25_i2v.api.json',
          inputs: { image: 'a_start', frames: 121, fps: 24, seed: 201, prompt: 'Photorealistic human skater.' },
        },
        media: { audio: 'none' }, notes: 'finishing sound plan: foley',
      },
    },
  };
  const covered = coverGeneratedFilmScenes(pkg);
  assert.equal(covered.splits, 1);
  assert.equal(covered.package.scenes.length, 4);
  assert.equal(covered.package.scenes.reduce((sum, scene) => sum + scene.preferredFrames, 0), 600);
  assert.equal(covered.package.assets.a_vid_old, undefined);
  const ids = covered.package.scenes.map(scene => scene.media[0].asset);
  assert.equal(new Set(ids).size, 4);
  assert.deepEqual(ids.map(id => covered.package.assets[id].gen.inputs.seed), [201, 202, 203, 204]);
  const intent = classifyProductionIntent('Create a 20-second live-action film with real humans.');
  const problems = generatedFilmCompletionProblems(covered.package, intent, 'auto');
  assert.equal(problems.some(problem => problem.includes('attached generated video covers')), false, problems.join('\n'));
});

test('coverage splitting keeps one opener and one outro instead of repeating bookends on every part', () => {
  const video = (seed) => ({
    kind: 'video', status: 'pending',
    gen: { generator: 'ltx25', workflow: 'workflows/ltx25_i2v.api.json', inputs: { image: 'a_start', frames: 121, fps: 24, seed } },
    media: { audio: 'none' },
  });
  const pkg = {
    format: { fps: 30 }, revision: 2,
    scenes: [
      { id: 's1', layout: 'title', variant: 'centered', preferredFrames: 600, copy: { headline: 'THE ATLAS' }, motion: { recipe: 'kinetic', entry: 'maskRise' }, media: [{ asset: 'a_open' }] },
      { id: 's2', layout: 'title', variant: 'outro', preferredFrames: 600, copy: { headline: 'HOME AGAIN' }, motion: { recipe: 'kinetic', entry: 'fadeUp' }, media: [{ asset: 'a_close' }], transitionOut: { type: 'fade', frames: 12 } },
    ],
    assets: { a_open: video(10), a_close: video(20) },
  };
  const covered = coverGeneratedFilmScenes(pkg);
  assert.equal(covered.splits, 2);
  assert.equal(covered.package.scenes.length, 8);
  assert.equal(covered.package.scenes.reduce((sum, scene) => sum + scene.preferredFrames, 0), 1200);
  assert.equal(covered.package.scenes[0].variant, 'centered');
  assert.equal(covered.package.scenes[0].copy.headline, 'THE ATLAS');
  assert.equal(covered.package.scenes.at(-1).variant, 'outro');
  assert.equal(covered.package.scenes.at(-1).copy.headline, 'HOME AGAIN');
  assert.equal(covered.package.scenes.at(-1).transitionOut, undefined);
  for (const scene of covered.package.scenes.slice(1, -1)) {
    assert.equal(scene.layout, 'list');
    assert.equal(scene.media_only, true);
    assert.equal(scene.copy, undefined);
    assert.equal(scene.motion, undefined);
  }
});

test('completion rejects clay substitutions for real humans and under-covered scene durations', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const intent = classifyProductionIntent('Create a 2 minute live-action video with real humans.');
  const pkg = {
    title: 'Six Clay Wipeouts',
    proposal: { logline: 'Human skaters fall.', look: 'Plasticine stop-motion.', soundtrack: 'Foley.' },
    format: { fps: 30 },
    scenes: [{ id: 's1', preferredFrames: 600, media: [{ asset: 'a_video' }] }],
    assets: {
      a_video: {
        kind: 'video',
        gen: {
          generator: 'ltx25', workflow: 'workflows/ltx25_i2v.api.json',
          inputs: { image: 'a_start', frames: 153, fps: 24 },
        },
        media: { audio: 'none' },
        notes: 'finishing sound plan: foley',
      },
    },
  };
  pkg.scenes[0].notes = 'LTX finishing sound plan: foley';
  const problems = generatedFilmCompletionProblems(pkg, intent, 'auto');
  assert.ok(problems.some(problem => problem.includes('real-human brief conflicts')), problems.join('\n'));
  assert.ok(problems.some(problem => problem.includes('scene is 20.00 seconds') && problem.includes('covers 6.38 seconds')), problems.join('\n'));
});

test('completion allows bounded transition drift and rejects larger duration misses', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const intent = classifyProductionIntent('Create a 20-second wordless generated film in 4 scenery shots. No captions.');
  const pkg = {
    proposal: { logline: 'A fire reaches a mineral break.', look: 'Blue-hour aerials.', soundtrack: 'Wind and embers.' },
    format: { fps: 30 },
    scenes: Array.from({ length: 4 }, (_, index) => ({
      id: `shot${index + 1}`, layout: 'hero', preferredFrames: 150,
      transitionOut: index === 0 ? { type: 'fade', frames: 14 } : index === 1 ? { type: 'blur', frames: 16 } : index === 2 ? { type: 'fade', frames: 14 } : { type: 'none' },
      media: [],
    })),
    assets: {},
  };
  const problems = generatedFilmCompletionProblems(pkg, intent, 'ltx');
  assert.ok(!problems.some(problem => problem.includes('20 seconds but the plan')), problems.join('\n'));
  for (const scene of pkg.scenes) scene.preferredFrames = 225;
  const excessive = generatedFilmCompletionProblems(pkg, intent, 'ltx');
  assert.ok(excessive.some(problem => problem.includes('20 seconds but the plan is 28.53 seconds')), excessive.join('\n'));
  assert.ok(excessive.some(problem => problem.includes('acceptable range is 17.00–23.00 seconds')), excessive.join('\n'));
});

test('narration-timed graphics require narration and exact cue phrases', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const intent = classifyProductionIntent('Create a 20-second narrated generated film in 4 shots with motion.cue_phrases copied verbatim from narration.');
  const pkg = {
    proposal: { logline: 'A mapped river changes course.', look: 'Indigo atlas pages.', soundtrack: 'Paper and water.' },
    format: { fps: 30 },
    scenes: [{ id: 'shot1', preferredFrames: 150, narration: 'The river changes course.', media: [] }],
    assets: {},
  };
  const problems = generatedFilmCompletionProblems(pkg, intent, 'klein');
  assert.ok(problems.some(problem => problem.includes('motion.cue_phrases')));
  pkg.scenes[0].motion = { cue_phrases: ['Changes course'] };
  assert.ok(generatedFilmCompletionProblems(pkg, intent, 'klein').some(problem => problem.includes('copied verbatim')));
  pkg.scenes[0].motion = { cue_phrases: ['changes course'] };
  assert.ok(!generatedFilmCompletionProblems(pkg, intent, 'klein').some(problem => problem.includes('motion.cue_phrases')));
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
