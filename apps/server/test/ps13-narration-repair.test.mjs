// PS13: a narration-timed repair must carry an actionable, brief-derived
// narration sentence and verbatim cue phrases. The model can copy that exact
// suggestion, but blank narration is never accepted as a completed repair.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';

const BRIEF = 'Create a 10-second narrated generated film in 2 shots. Two scenery-only controlled-burn hillside shots, no people. Documentary readouts may appear as on-screen labels. Narration-timed motion: every scene has narration and motion.cue_phrases copied verbatim from that scene\'s narration. Each shot needs an explicit finishing sound plan because the picture has no native dialogue.';
const PROPOSAL = {
  logline: 'Controlled burns shape the hillside at dusk.',
  look: 'Smoky documentary hillsides at golden hour.',
  soundtrack: 'Wind and distant fire crackle.',
};
const NARRATION = PROPOSAL.logline;
// A "no native dialogue" sound constraint must not be read as "no narration".
const PLANNING_BRIEF = BRIEF.replace('the picture has no native dialogue', 'the picture has picture-only audio');
const SCENES = [
  { id: 'shot1', layout: 'hero', preferredFrames: 150 },
  { id: 'shot2', layout: 'hero', preferredFrames: 150 },
];

async function setup(t, calls) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ps13-narration-repair-'));
  const provider = await replayProvider(calls);
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { provider, runner };
}

function initialCalls() {
  return [{
    name: 'storyboard.propose',
    args: { brief: PLANNING_BRIEF, title: 'Controlled Burn', proposal: PROPOSAL, scenes: SCENES },
  }];
}

/** Resolve the deterministic pending-still ids the LTX shots need as sources. */
async function plannedStillIds() {
  const { createToolset } = await import('../../../packages/agent/dist/src/index.js');
  const tools = createToolset({ generateSvg: () => ({ svg: '<svg/>' }) });
  await tools['storyboard.propose'].run(initialCalls()[0].args);
  const shot1 = await tools['assets.generate_image'].run({ scene_id: 'shot1', kind: 'illustration', intent: 'A controlled burn crosses a dry hillside at dusk.', seed: 11 });
  const shot2 = await tools['assets.generate_image'].run({ scene_id: 'shot2', kind: 'illustration', intent: 'Smoke settles over the burned hillside at dusk.', seed: 12 });
  return { shot1: shot1.asset.id, shot2: shot2.asset.id };
}

function narrationCue(narration, index) {
  const words = narration.split(/\s+/).filter(Boolean);
  const phrase = index % 2 === 0 ? words.slice(0, 2).join(' ') : words.slice(-2).join(' ');
  return phrase.replace(/^[^\w]+|[^\w]+$/g, '').trim();
}

function ltxShot(sceneId, imageId, index) {
  return {
    name: 'assets.generate_video',
    args: {
      scene_id: sceneId,
      motion_model: 'ltx',
      subject: index === 0 ? 'A controlled burn crossing a dry hillside.' : 'Smoke settling over a burned hillside.',
      composition: 'Documentary hillside at dusk.',
      action: 'Flames and smoke move slowly across the slope.',
      camera: 'Slow wide drift.',
      soundscape: 'Wind and distant fire crackle.',
      characterCount: 0,
      finishing_sound: 'Mix wind and distant fire crackle in finishing.',
      image: imageId,
      seed: 20 + index,
    },
  };
}

test('PS13 narration-timed repair carries an exact brief-derived narration and verbatim cues', async t => {
  const stills = await plannedStillIds();
  const { provider, runner } = await setup(t, initialCalls());
  const repair = [
    { name: 'storyboard.edit', args: { scene_id: 'shot1', patch: { narration: NARRATION, motion: { cue_phrases: [narrationCue(NARRATION, 0)] } } } },
    { name: 'storyboard.edit', args: { scene_id: 'shot2', patch: { narration: NARRATION, motion: { cue_phrases: [narrationCue(NARRATION, 1)] } } } },
    { name: 'assets.generate_image', args: { scene_id: 'shot1', kind: 'illustration', intent: 'A controlled burn crosses a dry hillside at dusk.', seed: 11 } },
    { name: 'assets.generate_image', args: { scene_id: 'shot2', kind: 'illustration', intent: 'Smoke settles over the burned hillside at dusk.', seed: 12 } },
    ltxShot('shot1', stills.shot1, 0),
    ltxShot('shot2', stills.shot2, 1),
  ];
  let repaired = false;
  const result = await runner({
    brief: BRIEF,
    provider: 'custom',
    motionModel: 'ltx',
    sessionId: 'ps13-narration-repair',
    onEvent: event => {
      if (event.type === 'done' && !repaired) {
        repaired = true;
        provider.setCalls(repair);
      }
    },
  });

  assert.equal(repaired, true, 'the blank narration really exercised the repair phase');
  assert.equal(result.fallback, false);
  assert.equal(result.live, true);

  const initialPrompt = JSON.stringify(provider.requests[0].messages);
  assert.match(initialPrompt, /no native dialogue/, 'the sound constraint stays in the brief now that audio classification distinguishes it from narration');
  assert.equal(result.package.voice.enabled, true, 'no-native-dialogue must not suppress the separate narration');

  const repairRequest = provider.requests[2];
  const system = repairRequest.messages[0].content;
  assert.match(system, /narration-timed/i);
  assert.match(system, /scene\.narration/);
  assert.match(system, /cue_phrases/);
  assert.match(system, /exact narration sentence/i, 'the system prompt tells the model to copy the supplied suggestion');

  const prompt = JSON.stringify(repairRequest.messages);
  assert.match(prompt, /Narration-timed repair/i);
  assert.match(prompt, /shot1/);
  assert.match(prompt, /shot2/);
  assert.match(prompt, /scene\.narration is missing/i);
  assert.ok(prompt.includes(NARRATION), 'the repair names the exact brief-derived narration sentence');
  assert.ok(prompt.includes(narrationCue(NARRATION, 0)), 'the repair names a verbatim cue phrase for the first scene');
  assert.ok(prompt.includes(narrationCue(NARRATION, 1)), 'the repair names a verbatim cue phrase for the second scene');
  assert.match(prompt, /verbatim/i);

  assert.equal(result.package.scenes[0].narration, NARRATION);
  assert.equal(result.package.scenes[1].narration, NARRATION);
  for (const scene of result.package.scenes) {
    assert.ok(Array.isArray(scene.motion.cue_phrases) && scene.motion.cue_phrases.length > 0);
    for (const phrase of scene.motion.cue_phrases) assert.ok(scene.narration.includes(phrase), `${phrase} is verbatim`);
  }
});

test('PS13 a repair that leaves blank narration is refused per scene', async t => {
  const { provider, runner } = await setup(t, initialCalls());
  let repaired = false;
  const error = await runner({
    brief: BRIEF,
    provider: 'custom',
    motionModel: 'ltx',
    sessionId: 'ps13-narration-blank',
    onEvent: event => {
      if (event.type === 'done' && !repaired) {
        repaired = true;
        provider.setCalls([]);
      }
    },
  }).then(() => null, cause => cause);

  assert.ok(error, 'blank narration must not be accepted');
  assert.equal(repaired, true, 'the blank plan really exercised the repair phase');
  assert.equal(error.status, 422);
  assert.equal(error.code, 'GENERATED_FILM_INCOMPLETE');

  const narrationProblems = error.errors.filter(line => /narration-timed motion graphics require a concise scene\.narration sentence/.test(line));
  assert.equal(narrationProblems.length, 2, JSON.stringify(error.errors));
  assert.ok(narrationProblems.some(line => line.startsWith('shot1:')));
  assert.ok(narrationProblems.some(line => line.startsWith('shot2:')));

  const repairPrompt = JSON.stringify(provider.requests.at(-1)?.messages ?? []);
  assert.ok(repairPrompt.includes(NARRATION), 'even a failing repair was told the exact narration to use');
});
