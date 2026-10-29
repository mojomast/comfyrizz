import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneShotPlates, plannedShotProblems } from '../src/scene-shot-plates.mjs';
import { coverGeneratedFilmScenes, generatedFilmCompletionProblems, createCpuAgentRunner } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';
import { planJobs } from '../../../packages/jobs/src/index.mjs';

const video = frames => ({ kind: 'video', status: 'pending', media: { audio: 'none' }, notes: 'finishing sound plan: ambient room', gen: {
  generator: 'ltx25', workflow: 'workflows/ltx25_i2v_2stage.api.json', inputs: { image: 'portrait', frames, fps: 24, seed: 1 },
} });
const intent = { requestedSeconds: null, wordless: true };
function film(scene) {
  return { format: { fps: 30 }, proposal: { logline: 'Hands shape dough.', look: 'Natural documentary.', soundtrack: 'Ambient room.' },
    scenes: [{ id: 's1', preferredFrames: 150, notes: 'LTX finishing sound plan: ambient room', ...scene }],
    assets: { portrait: { kind: 'image', gen: { generator: 'flux3-klein' } }, action: video(121), other: video(121) },
  };
}

test('a hidden dough-shaping clip cannot satisfy generated shot completion', () => {
  const pkg = film({ layout: 'hero', background: { asset: 'portrait' }, media: [{ asset: 'action' }, { asset: 'action' }] });
  assert.ok(generatedFilmCompletionProblems(pkg, intent).some(message => /unused media entries/.test(message)));
  assert.equal(plannedShotProblems(pkg, new Map([['s1', 'action']]))[0].code, 'PLANNED_SHOT_NOT_VISIBLE');
  pkg.scenes[0].background = { asset: 'action' };
  delete pkg.scenes[0].media;
  assert.deepEqual(generatedFilmCompletionProblems(pkg, intent), []);
  assert.deepEqual(plannedShotProblems(pkg, new Map([['s1', 'action']])), []);
});

test('panel coverage is simultaneous, and a procedural background shadows its asset', () => {
  const pkg = film({ layout: 'compare', preferredFrames: 270, media: [{ asset: 'action' }, { asset: 'other' }] });
  assert.ok(generatedFilmCompletionProblems(pkg, intent).some(message => /covers 5.04 seconds/.test(message)));
  assert.equal(coverGeneratedFilmScenes(pkg).splits, 0, 'do not silently replace a two-panel comparison with sequential clips');
  assert.deepEqual(sceneShotPlates({ layout: 'hero', background: { asset: 'action', procedural: { pattern: 'grid' } } }), []);
  assert.deepEqual(sceneShotPlates({ layout: 'compare', media_only: true, background: { asset: 'action' }, media: [{ asset: 'other' }] }), [{ asset: 'action' }]);
});

test('coverage repair writes each new clip to the visible slot and preserves unrelated references', () => {
  const pkg = film({ layout: 'list', preferredFrames: 360, background: { asset: 'action' }, media: [{ asset: 'action' }, { asset: 'action' }] });
  pkg.scenes.push({ id: 'detail', layout: 'list', preferredFrames: 60, background: { asset: 'other' }, foreground: [{ asset: 'action' }] });
  const covered = coverGeneratedFilmScenes(pkg);
  assert.equal(covered.splits, 1);
  assert.equal(covered.package.scenes.length, 4);
  for (const scene of covered.package.scenes.slice(0, 3)) {
    assert.notEqual(scene.background.asset, 'action');
    assert.ok(covered.package.assets[scene.background.asset]);
    assert.equal(scene.media, undefined);
  }
  assert.ok(covered.package.assets.action, 'the old asset is still referenced by a different authored foreground');
  assert.deepEqual(pkg.scenes[0].background, { asset: 'action' }, 'the input remains unchanged');
});

test('authored trim and playback speed remain authoritative during coverage repair', () => {
  const pkg = film({ layout: 'list', preferredFrames: 180, background: { asset: 'action', trim: { startSeconds: 1, endSeconds: 4 }, speed: 2 } });
  const covered = coverGeneratedFilmScenes(pkg);
  assert.equal(covered.splits, 0);
  assert.deepEqual(covered.package, pkg);
  assert.ok(generatedFilmCompletionProblems(pkg, intent).some(message => /covers 1.50 seconds/.test(message)));
});

for (const repaired of [false, true]) {
  test(`motion-graphics completion ${repaired ? 'restores the existing action' : 'rejects a still substituted for planned action'} across bounded repair`, async t => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'visible-shot-'));
    const brief = 'A 5-second native motion-graphics title over a kitchen action plate. No narration. No music.';
    let imageId, videoId;
    const lastAsset = request => request.messages.filter(message => message.role === 'tool')
      .map(message => JSON.parse(message.content)).findLast(result => result.asset?.id)?.asset;
    const provider = await replayProvider([
      { name: 'storyboard.propose', args: { brief, scenes: [{ id: 's1', layout: 'title', preferredFrames: 150, copy: { headline: 'EARLY SHIFT' } }] } },
      { name: 'assets.generate_image', args: { scene_id: 's1', kind: 'reference', intent: 'Hands above dough on a wooden bakery workbench' } },
      request => {
        imageId = lastAsset(request).id;
        return { name: 'assets.generate_video', args: { scene_id: 's1', motion_model: 'ltx', image: imageId, subject: 'Dough on a wooden workbench', composition: 'Close view of hands and dough', action: 'Hands fold the dough', camera: 'Static camera', soundscape: 'Quiet bakery ambience', finishing_sound: 'Quiet bakery ambience', characterCount: 0 } };
      },
      request => {
        videoId = lastAsset(request).id;
        return { name: 'storyboard.edit', args: { scene_id: 's1', patch: { background: { asset: imageId } } } };
      },
      null,
      ...(repaired ? [() => ({ name: 'storyboard.edit', args: { scene_id: 's1', patch: { background: { asset: videoId } } } })] : []),
    ]);
    t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
    const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
    const run = runner({ brief, provider: 'custom', videoType: 'motion-explainer' });
    if (!repaired) await assert.rejects(run, error => error.code === 'MOTION_GRAPHICS_INCOMPLETE' && /PLANNED_SHOT_NOT_VISIBLE/.test(error.message));
    else {
      const result = await run;
      assert.equal(result.package.scenes[0].background.asset, videoId);
      assert.equal(planJobs(result.package).jobs.filter(job => job.asset === videoId || job.assetId === videoId).length, 1);
    }
    assert.match(JSON.stringify(provider.requests[5].messages), /PLANNED_SHOT_NOT_VISIBLE/);
  });
}
