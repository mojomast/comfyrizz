import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCpuAgentRunner, motionGraphicsCompletionProblems } from '../src/agent-runner.mjs';
import { replayProvider, withPlannedPlate } from './fake-provider.mjs';

const NARRATION = 'The jerboa lifts the lamp.';

test('recorded Data Story correction and media prohibition lists do not request GPU stills', () => {
  const slice = { package: { scenes: [{ id: 's_title', layout: 'title', copy: { headline: 'FICTIONAL STUDY LOG' } }], assets: {} }, pendingGpu: [], problems: [] };
  const missing = brief => motionGraphicsCompletionProblems(slice, brief).some(problem => problem.code === 'PENDING_GPU_MISSING');
  const recorded = 'Create exactly 20 seconds of landscape native motion graphics: a Data Story titled FICTIONAL STUDY LOG. Use only native editable typography and a native bar chart; no generated images, stills, footage or GPU assets. The attached fictional-study.csv has four fictional practice measurements. In source order the exact day/value pairs are Monday=10, Tuesday=15, Wednesday=20, Thursday=25. The unit for every value is minutes. These are measured values from the minutes column, never counts of rows. Show exactly four bars with those exact day labels, numeric values and the minutes unit. Keep FICTIONAL STUDY LOG visibly readable to identify this as a fictional illustration. End with Thursday and its value 25 highlighted. Navy, cream and one orange highlight. Simple bar reveal, followed by a readable static final hold. No narration, inferred causes, percentages or additional statistics. A gentle instrumental bed is optional if supported. The full film runtime is exactly 20 seconds.';
  assert.equal(missing(recorded), false);
  for (const list of [
    'No generated images, stills, footage or GPU assets',
    'Without footage, generated stills, or keyframes',
    'Avoid images and stills',
    'Exclude stock photographs, still images and keyframes',
    'Do not use generated images, stills or footage',
    'Never generate footage or stills',
  ]) {
    assert.equal(missing(`${list}. Keep the ending completely still.`), false, list);
    for (const separator of ['. ', '; ', ', but ', ', ', ' and ']) {
      assert.equal(missing(`${list}${separator}add a texture still for the ending.`), true, `${list}${separator}`);
    }
  }
});

test('static title holds do not request GPU stills; actual image requests remain checked', () => {
  const slice = { package: { scenes: [{ id: 's_title', layout: 'title', copy: { headline: 'PLEASE HOLD' } }], assets: {} }, pendingGpu: [], problems: [] };
  const missing = brief => motionGraphicsCompletionProblems(slice, brief).some(problem => problem.code === 'PENDING_GPU_MISSING');
  for (const brief of [
    'Keep the final three seconds completely still.',
    'Hold the title still. The letters should still be readable.',
    'Use no generated stills.',
    'Avoid still images. Use native typography.',
    'Do not generate a still.',
  ]) assert.equal(missing(brief), false, brief);
  for (const brief of ['Include a texture still.', 'Generate one still.', 'Use two keyframes.', 'Add a still image.']) {
    assert.equal(missing(brief), true, brief);
  }
  slice.package.assets.a_photo = { kind: 'image', status: 'ready' };
  assert.equal(missing('Use a still image.'), true, 'an orphan image is insufficient');
  slice.package.scenes[0].foreground = [{ asset: 'a_photo' }];
  assert.equal(missing('Use a still image.'), false, 'a ready referenced image needs no extra GPU plan');
});

test('drawing continuity is checked only for an explicit continuous plan', () => {
  const line = { type: 'path', points: [[100, 100], [300, 100]], color: '#111111', width: 3, start: 0, end: 20 };
  const slice = { package: { scenes: [
    { id: 's1', drawing: { elements: [line] } },
    { id: 's2', drawing: { elements: [{ ...line, points: [[10, 10], [20, 20]] }] } },
  ] }, svgAssets: [], pendingGpu: [], problems: [] };
  const codes = brief => motionGraphicsCompletionProblems(slice, brief).map(problem => problem.code);
  assert.ok(codes('The drawing grows. Finish on the completed sheet.').includes('DRAWING_DISCONTINUITY'));
  assert.ok(!codes('Show a drawing, then a different diagram.').includes('DRAWING_DISCONTINUITY'));
  slice.package.scenes[1].drawing.elements = [{ ...line, start: 0, end: 0 }];
  assert.ok(!codes('The drawing grows. Finish on the completed sheet.').includes('DRAWING_DISCONTINUITY'));
  delete slice.package.scenes[1].drawing;
  const mixed = codes('Show a drawing, then a different diagram.');
  assert.ok(!mixed.includes('DRAWING_MISSING'));
  assert.ok(!mixed.includes('PENDING_GPU_MISSING'));
  assert.ok(codes('The drawing grows. Finish on the completed sheet.').includes('DRAWING_MISSING'));
});
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

test('native planner retains speech prohibitions despite narration-cue wording', async t => {
  for (const constraint of ['Silent', 'No audio', 'No spoken words']) {
    const brief = `Create exactly 6 seconds of motion graphics. ${constraint}. Narration-timed motion with cue_phrases.`;
    const { runner, provider } = await setup(t, withPlannedPlate([{ name: 'storyboard.propose', args: {
      brief, title: 'QUIET', proposal: { logline: 'A readable title.', look: 'Plain cream.', soundtrack: 'Silent.' },
      scenes: [{ id: 's_title', layout: 'title', preferredFrames: 180, narration: 'Unrequested speech.', motion: { cue_phrases: ['Unrequested'] }, copy: { headline: 'QUIET' } }],
    } }], 's_title'));
    const result = await runner({ brief, videoType: 'title-reveal', provider: 'custom' });
    assert.equal(result.package.scenes[0].narration, undefined, constraint);
    assert.equal(result.package.scenes[0].motion?.cue_phrases, undefined, constraint);
    assert.equal(result.package.voice.enabled, false, constraint);
    assert.equal(provider.requests.length, 4, 'no narration repair required; the supporting image is explicitly planned and placed');
  }
});

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

test('PS08 motion-graphics repair plans the requested scene-referenced still without adding SVGs', async t => {
  const brief = 'Create a 5-second two-scene motion-graphics kinetic bumper with a texture still. Scene one headline is exactly "MAKE IT". Scene two headline is exactly "MOVE". Bold cuts. No narration.';
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
  assert.deepEqual(result.svgAssets, []);
  assert.equal(result.usage.svg.requests, 0);
  assert.ok(result.pendingGpu.length >= 1);
  assert.ok(result.pendingGpu.some(item => item.sceneId === 's_one'), 'the planned still is scene-referenced');

  const request = provider.requests[2];
  const system = request.messages[0].content;
  assert.match(system, /Create assets only when needed to resolve a reported media\/coverage issue/i);

  const prompt = JSON.stringify(request.messages);
  assert.match(prompt, /Pending GPU still repair/i);
  assert.match(prompt, /scene_id/);
  assert.match(prompt, /s_one/);
  assert.doesNotMatch(prompt, /SVG floor|SVG_ASSET_FLOOR/i);
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
  }, 'Include a texture still.');
  assert.ok(
    problems.some(problem => problem.code === 'PENDING_GPU_MISSING' && problem.count === 0),
    JSON.stringify(problems),
  );
});
