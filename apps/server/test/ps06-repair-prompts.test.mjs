import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';

const PROPOSAL = {
  logline: 'A felt jerboa restores the lighthouse lamp before the boat arrives.',
  look: 'Handcrafted felt miniatures at dusk.',
  soundtrack: 'Coastal wind and a soft lens click.',
};
const NARRATION = 'The jerboa lifts the lamp.';
const SCENES = [{ id: 'shot1', layout: 'hero', preferredFrames: 300, narration: NARRATION }];
const REPAIR_CALLS = [
  {
    name: 'storyboard.edit',
    args: { scene_id: 'shot1', patch: { preferredFrames: 180, motion: { cue_phrases: ['lifts the lamp'] } } },
  },
  {
    name: 'assets.generate_video',
    args: {
      scene_id: 'shot1',
      motion_model: 'klein',
      subject: 'A mustard felt jerboa.',
      composition: 'A handcrafted lighthouse lamp room at dusk.',
      action: 'The jerboa lifts the lamp into place.',
      camera: 'Static camera.',
      soundscape: 'Coastal wind and a soft lens click.',
      characterCount: 1,
      finishing_sound: 'Mix coastal wind and the lens click in finishing.',
    },
  },
];

async function setup(t, calls) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ps06-repair-prompts-'));
  const provider = await replayProvider(calls);
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { provider, runner };
}

/** Run one generated-film plan that needs a repair, then return the repair request. */
async function repairRequest(t, brief, proposeBrief) {
  const initial = [{
    name: 'storyboard.propose',
    args: { brief: proposeBrief, title: 'The Lamp at Dusk', proposal: PROPOSAL, scenes: SCENES },
  }];
  const { provider, runner } = await setup(t, initial);
  let repaired = false;
  const result = await runner({
    brief,
    provider: 'custom',
    motionModel: 'klein',
    sessionId: 'ps06-repair-prompts',
    onEvent: event => {
      if (event.type === 'done' && !repaired) {
        repaired = true;
        provider.setCalls(REPAIR_CALLS);
      }
    },
  });
  assert.equal(repaired, true, 'the incomplete plan really exercised the repair phase');
  assert.equal(result.fallback, false);
  assert.equal(result.live, true);
  assert.equal(provider.requests.length, 5, 'one live plan plus one bounded repair, never a scripted fallback');
  const request = provider.requests[2];
  return { request, result };
}

test('repair prompt teaches narration cues, Klein stills and brief aspect', async t => {
  const brief = 'Create a 6-second vertical 9:16 generated film in 1 shot. A mustard felt jerboa restores a lighthouse lamp at dusk with cinematic camera moves and coastal sound. Narration-timed motion with cue_phrases copied verbatim. No captions.';
  const proposeBrief = brief.replace('vertical 9:16 ', '');
  const { request, result } = await repairRequest(t, brief, proposeBrief);

  const system = request.messages[0].content;
  assert.match(system, /narration-timed/i);
  assert.match(system, /cue_phrases/);
  assert.match(system, /FLUX 3 Image Klein still/i);
  assert.match(system, /aspect and format/i);

  const prompt = JSON.stringify(request.messages);
  assert.match(prompt, /cue_phrases=\[\]/);
  assert.match(prompt, /klein_stills=0/);
  assert.match(prompt, /draft aspect=16:9/);
  assert.match(prompt, /brief aspect=9:16/);
  assert.match(prompt, /Aspect repair/);
  assert.deepEqual(result.package.format, { width: 1920, height: 1080, fps: 30 }, 'the fake provider really produced a brief/draft aspect mismatch');
});

test('repair prompt omits the aspect repair line when brief and draft match', async t => {
  const brief = 'Create a 6-second vertical 9:16 generated film in 1 shot. A mustard felt jerboa restores a lighthouse lamp at dusk with cinematic camera moves and coastal sound. Narration-timed motion with cue_phrases copied verbatim. No captions.';
  const { request, result } = await repairRequest(t, brief, brief);

  const prompt = JSON.stringify(request.messages);
  assert.match(prompt, /draft aspect=9:16/);
  assert.match(prompt, /brief aspect=9:16/);
  assert.doesNotMatch(prompt, /Aspect repair/);
  assert.deepEqual(result.package.format, { width: 1080, height: 1920, fps: 30 });
});
