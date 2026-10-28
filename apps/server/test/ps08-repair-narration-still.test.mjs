import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCpuAgentRunner, motionGraphicsCompletionProblems } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';

const NARRATION = 'The jerboa lifts the lamp.';
const PROPOSAL = {
  logline: 'A felt jerboa restores the lighthouse lamp before the boat arrives.',
  look: 'Handcrafted felt miniatures at dusk.',
  soundtrack: 'Coastal wind and a soft lens click.',
};

async function setup(t, calls) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ps08-repair-'));
  const provider = await replayProvider(calls);
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { provider, runner };
}

test('PS08 narration-timed repair demands scene.narration and verbatim cue phrases', async t => {
  const brief = 'Create a 6-second generated film in 1 shot. A mustard felt jerboa restores a lighthouse lamp at dusk with cinematic camera moves and coastal sound. Narration-timed motion with cue_phrases copied verbatim. No captions.';
  const initial = [{
    name: 'storyboard.propose',
    args: {
      brief,
      title: 'The Lamp at Dusk',
      proposal: PROPOSAL,
      scenes: [{ id: 'shot1', layout: 'hero', preferredFrames: 180 }],
    },
  }];
  const repair = [
    {
      name: 'storyboard.edit',
      args: {
        scene_id: 'shot1',
        patch: { narration: NARRATION, motion: { cue_phrases: ['lifts the lamp'] } },
      },
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
  const { provider, runner } = await setup(t, initial);
  let repaired = false;
  const result = await runner({
    brief,
    provider: 'custom',
    motionModel: 'klein',
    sessionId: 'ps08-narration-repair',
    onEvent: event => {
      if (event.type === 'done' && !repaired) {
        repaired = true;
        provider.setCalls(repair);
      }
    },
  });

  assert.equal(repaired, true, 'the missing narration really exercised the repair phase');
  assert.equal(result.fallback, false);
  const request = provider.requests[2];
  const system = request.messages[0].content;
  assert.match(system, /narration-timed/i);
  assert.match(system, /scene\.narration/);
  assert.match(system, /cue_phrases/);
  assert.match(system, /never remove|preserve/i, 'a repair must not blank narration while fixing another field');

  const prompt = JSON.stringify(request.messages);
  assert.match(prompt, /Narration-timed repair/i);
  assert.match(prompt, /shot1/);
  assert.match(prompt, /scene\.narration is missing/i);
  assert.match(prompt, /verbatim/i);

  assert.equal(result.package.scenes[0].narration, NARRATION);
  assert.deepEqual(result.package.scenes[0].motion.cue_phrases, ['lifts the lamp']);
  assert.ok(result.package.scenes[0].narration.includes(result.package.scenes[0].motion.cue_phrases[0]));
});

test('PS08 motion-graphics repair names the SVG floor and a scene-referenced pending still', async t => {
  const brief = 'Create a 5-second two-scene motion-graphics kinetic bumper. Scene one headline is exactly "MAKE IT". Scene two headline is exactly "MOVE". Bold cuts. No narration.';
  const scenes = [
    { id: 's_one', layout: 'title', preferredFrames: 75, copy: { headline: 'MAKE IT' } },
    { id: 's_two', layout: 'title', preferredFrames: 75, copy: { headline: 'MOVE' } },
  ];
  const initial = [{
    name: 'storyboard.propose',
    args: {
      brief,
      title: 'Kinetic Bumper',
      proposal: {
        logline: 'Two hard cuts spell out the call to move.',
        look: 'Bold ink type on an electric field.',
        soundtrack: 'Percussive clicks without speech.',
      },
      scenes,
    },
  }];
  const repair = [
    { name: 'assets.generate_svg', args: { scene_id: 's_one', kind: 'diagram', intent: 'MAKE IT kinetic slab', seed: 1 } },
    { name: 'assets.generate_svg', args: { scene_id: 's_one', kind: 'pattern', intent: 'electric field pattern', seed: 2 } },
    { name: 'assets.generate_svg', args: { scene_id: 's_two', kind: 'diagram', intent: 'MOVE kinetic arrow', seed: 3 } },
    { name: 'assets.generate_svg', args: { scene_id: 's_two', kind: 'icon', intent: 'motion icon', seed: 4 } },
    { name: 'assets.generate_image', args: { scene_id: 's_one', kind: 'illustration', intent: 'a workshop texture still', seed: 5 } },
  ];
  const { provider, runner } = await setup(t, initial);
  let repaired = false;
  const result = await runner({
    brief,
    provider: 'custom',
    sessionId: 'ps08-mg-repair',
    onEvent: event => {
      if (event.type === 'done' && !repaired) {
        repaired = true;
        provider.setCalls(repair);
      }
    },
  });

  assert.equal(repaired, true, 'the incomplete package really exercised the repair phase');
  assert.equal(result.fallback, false);
  assert.ok(result.svgAssets.length >= 4);
  assert.ok(result.pendingGpu.length >= 1);
  assert.ok(result.pendingGpu.some(item => item.sceneId === 's_one'), 'the planned still is scene-referenced');

  const request = provider.requests[2];
  const system = request.messages[0].content;
  assert.match(system, /at least 4 ready llm-svg assets/i);
  assert.match(system, /scene-referenced/i);
  assert.match(system, /reference, identity, cast, portrait or start-frame/i);

  const prompt = JSON.stringify(request.messages);
  assert.match(prompt, /Pending GPU still repair/i);
  assert.match(prompt, /scene_id/);
  assert.match(prompt, /s_one/);
  assert.match(prompt, /SVG floor/i);
});

test('PS08 a pending still without a scene reference does not satisfy the motion-graphics floor', () => {
  const pkg = {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_ps08_pending',
    title: 'Bumper',
    createdAt: '2026-10-28T12:00:00.000Z',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    datasets: {},
    scenes: [{ id: 's_one', layout: 'title', preferredFrames: 75, copy: { headline: 'MAKE IT' }, foreground: [] }],
    assets: {
      a_img: {
        kind: 'image',
        origin: 'generated',
        status: 'pending',
        license: { id: 'CC0-1.0' },
        redistributable: true,
        gen: {
          generator: 'flux3-klein',
          workflow: 'workflows/flux3_klein_t2i.api.json',
          workflow_sha256: 'a'.repeat(64),
          model: 'flux-3-klein',
          inputs: { prompt: 'orphan still', width: 1920, height: 1080, seed: 0 },
          backend: 'colab:G4',
        },
      },
    },
    compliance: { open_weights_only: true },
    renders: [],
  };
  const problems = motionGraphicsCompletionProblems({
    package: pkg,
    svgAssets: ['a1', 'a2', 'a3', 'a4'],
    pendingGpu: [{ assetId: 'a_img', generator: 'flux3-klein' }],
    problems: [],
  });
  assert.ok(
    problems.some(problem => problem.code === 'PENDING_GPU_MISSING' && problem.count === 0),
    JSON.stringify(problems),
  );
});
