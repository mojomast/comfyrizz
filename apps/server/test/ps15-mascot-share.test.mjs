// PS15: when the brief requires "the same mascot in every scene", a repair or
// completion must name the one fictional cast id and every scene that lacks it.
// Blank or divergent scene.cast is never a completed plan, and the gate never
// invents a real-person cast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCpuAgentRunner,
  generatedFilmCompletionProblems,
  motionGraphicsCompletionProblems,
} from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';

const BRIEF = 'Create a 10-second two-scene motion-graphics library-book sorting sequence. Use the same mascot in every scene: one shared fictional paper-moth mascot, never a real person. Draw four SVG props and plan one library background still. No narration and no fabricated statistics.';
const PROPOSAL = {
  logline: 'A paper moth sorts returned library books onto the right shelves.',
  look: 'Warm paper cutouts with soft library light.',
  soundtrack: 'Quiet room tone and page turns.',
};
const SCENES = [
  { id: 's_sort', layout: 'hero', preferredFrames: 150, copy: { headline: 'SORT' } },
  { id: 's_shelve', layout: 'hero', preferredFrames: 150, copy: { headline: 'SHELVE' } },
];
const MASCOT = {
  id: 'c_pip',
  name: 'Pip',
  description: 'Pip is a fictional round paper-moth mascot. Not a real person.',
  ref_asset: 'a_cast_pip',
};

async function setup(t, calls) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ps15-mascot-share-'));
  const provider = await replayProvider(calls);
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { provider, runner };
}

/** Propose with the mascot phrase, then drop scene.cast so only the repair can restore it. */
function initialCalls() {
  return [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'Library Sort', proposal: PROPOSAL, scenes: SCENES } },
    { name: 'storyboard.edit', args: { scene_id: 's_sort', patch: { cast: null } } },
    { name: 'storyboard.edit', args: { scene_id: 's_shelve', patch: { cast: null } } },
  ];
}

function assetCalls() {
  return [
    { name: 'assets.generate_svg', args: { scene_id: 's_sort', kind: 'icon', intent: 'a sorting cart icon', seed: 1 } },
    { name: 'assets.generate_svg', args: { scene_id: 's_sort', kind: 'diagram', intent: 'a sorting flow diagram', seed: 2 } },
    { name: 'assets.generate_svg', args: { scene_id: 's_shelve', kind: 'icon', intent: 'a shelf label icon', seed: 3 } },
    { name: 'assets.generate_svg', args: { scene_id: 's_shelve', kind: 'pattern', intent: 'a paper-moth wing pattern', seed: 4 } },
    { name: 'assets.generate_image', args: { scene_id: 's_shelve', kind: 'background', intent: 'a library background still', seed: 9 } },
  ];
}

/** The repair only tells the model to restore the one shared fictional cast id. */
function castRepairCalls() {
  return [
    { name: 'storyboard.edit', args: { scene_id: 's_sort', patch: { cast: ['c_pip'] } } },
    { name: 'storyboard.edit', args: { scene_id: 's_shelve', patch: { cast: ['c_pip'] } } },
  ];
}

function repairRequest(provider) {
  return provider.requests.find(request => JSON.stringify(request.messages).includes('Validation report: the current motion-graphics package is incomplete'));
}

function sharedCastProblems(problems) {
  return problems.filter(problem => typeof problem === 'string' && problem.startsWith('SHARED_CAST_MISSING:'));
}

test('PS15 repair prompt names the exact shared mascot cast and every scene lacking it', async t => {
  const { provider, runner } = await setup(t, initialCalls());
  let repaired = false;
  const result = await runner({
    brief: BRIEF,
    provider: 'custom',
    sessionId: 'ps15-mascot-repair',
    onEvent: event => {
      if (event.type === 'done' && !repaired) {
        repaired = true;
        provider.setCalls([...castRepairCalls(), ...assetCalls()]);
      }
    },
  });

  assert.equal(repaired, true, 'the cast-less plan really exercised the repair phase');
  assert.equal(result.fallback, false);
  assert.equal(result.live, true);

  const request = repairRequest(provider);
  assert.ok(request, 'the runner sent a motion-graphics repair prompt');
  const prompt = JSON.stringify(request.messages);
  assert.match(prompt, /SHARED_CAST_MISSING/);
  assert.ok(prompt.includes('c_pip'), 'the repair names the exact shared fictional cast id');
  assert.ok(prompt.includes('s_sort'), 'the repair names the first scene lacking the cast');
  assert.ok(prompt.includes('s_shelve'), 'the repair names the second scene lacking the cast');
  assert.match(prompt, /storyboard\.edit/, 'the repair gives one concrete edit instruction');
  assert.match(prompt, /never substitute a real person/i);

  assert.deepEqual(result.package.cast.map(member => member.id), ['c_pip']);
  for (const scene of result.package.scenes) {
    assert.ok(Array.isArray(scene.cast) && scene.cast.includes('c_pip'), `${scene.id} shares Pip`);
  }
});

test('PS15 a repair that leaves scene.cast divergent is refused with SHARED_CAST_MISSING', async t => {
  const { provider, runner } = await setup(t, initialCalls());
  let repaired = false;
  const error = await runner({
    brief: BRIEF,
    provider: 'custom',
    sessionId: 'ps15-mascot-missing',
    onEvent: event => {
      if (event.type === 'done' && !repaired) {
        repaired = true;
        provider.setCalls(assetCalls());
      }
    },
  }).then(() => null, cause => cause);

  assert.ok(error, 'a divergent shared cast must not be accepted');
  assert.equal(repaired, true, 'the cast-less plan really exercised the repair phase');
  assert.equal(error.status, 422);
  assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');

  const shared = sharedCastProblems(error.errors);
  assert.equal(shared.length, 1, JSON.stringify(error.errors));
  assert.ok(shared[0].includes('c_pip'), 'the refusal names the exact cast id');
  assert.ok(shared[0].includes('s_sort'), 'the refusal names the scene still lacking the cast');
  assert.deepEqual(error.details.sceneIds, ['s_sort'], 'details list every scene still lacking the cast');
  assert.match(shared[0], /storyboard\.edit/);
  assert.ok(error.details.codes.includes('SHARED_CAST_MISSING'));
});

test('PS15 generated-film completion flags a scene that lacks the shared mascot', () => {
  const pkg = {
    format: { width: 1920, height: 1080, fps: 30 },
    proposal: {
      logline: 'A paper moth sorts returned library books.',
      look: 'Warm paper cutouts with soft library light.',
      soundtrack: 'Quiet room tone and page turns.',
    },
    cast: [MASCOT],
    scenes: [
      { id: 'shot1', preferredFrames: 150, cast: ['c_pip'] },
      { id: 'shot2', preferredFrames: 150 },
      { id: 'shot3', preferredFrames: 150, cast: ['c_other'] },
    ],
  };
  const intent = { requestedSeconds: null, requiresNarrationCues: false, wordless: false, noCaptions: false };
  const problems = sharedCastProblems(generatedFilmCompletionProblems(pkg, intent, 'auto', BRIEF));

  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes('c_pip'));
  assert.ok(problems[0].includes('shot2') && problems[0].includes('shot3'), 'both the missing and the divergent scene are named');
  assert.ok(!problems[0].includes('shot1'), 'a scene that already shares the cast is not listed');
  assert.match(problems[0], /storyboard\.edit/);
  assert.match(problems[0], /never substitute a real person/i);
});

test('PS15 motion-graphics completion needs a recorded fictional cast id too', () => {
  const pkg = {
    id: 'pkg_ps15',
    title: 'Library Sort',
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [
      { id: 's_sort', layout: 'hero', preferredFrames: 150, copy: { headline: 'SORT' } },
      { id: 's_shelve', layout: 'hero', preferredFrames: 150, copy: { headline: 'SHELVE' } },
    ],
  };
  const problems = motionGraphicsCompletionProblems({
    package: pkg,
    svgAssets: [{}, {}, {}, {}],
    pendingGpu: [{ sceneId: 's_shelve' }],
    problems: [],
  }, BRIEF);

  const shared = problems.filter(problem => problem.code === 'SHARED_CAST_MISSING');
  assert.equal(shared.length, 1, JSON.stringify(problems));
  assert.ok(shared[0].message.includes('c_pip'), 'the repair names the shared fictional mascot id');
  assert.ok(shared[0].message.includes('s_sort') && shared[0].message.includes('s_shelve'));
  assert.match(shared[0].message, /storyboard\.edit/);
});

test('PS15 a brief without the mascot requirement is unaffected', () => {
  const pkg = {
    format: { width: 1920, height: 1080, fps: 30 },
    proposal: { logline: 'A library sorts itself.', look: 'Paper cutouts.', soundtrack: 'Room tone.' },
    scenes: [{ id: 'shot1', preferredFrames: 150 }],
  };
  const intent = { requestedSeconds: null, requiresNarrationCues: false, wordless: false, noCaptions: false };
  const problems = generatedFilmCompletionProblems(pkg, intent, 'auto', 'Create a one-shot library motion-graphics title.');
  assert.equal(sharedCastProblems(problems).length, 0);
});
