import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline } from '../../../../packages/planner/dist/src/index.js';
import { listClips } from '../../src/takes/clips.mjs';

const GEN = { generator: 'flux3-klein', prompt: 'a clean product shot' };
const VIDEO_GEN = { generator: 'ltx25-i2v', prompt: 'a slow push-in' };
const PRESENTER_GEN = { generator: 'ltx25-a2v', prompt: 'a presenter speaking' };

function makePackage() {
  return {
    id: 'pkg_clips',
    format: { width: 1920, height: 1080, fps: 30 },
    presenter: { enabled: true, scenes: ['s_one'], portrait: 'a_presenter' },
    scenes: [
      {
        id: 's_one',
        layout: 'hero',
        preferredFrames: 90,
        background: { asset: 'a_bg' },
        foreground: [
          { asset: 'a_plate', x: 0.5, y: 0.5, w: 0.4 },
          { asset: 'a_shared', x: 0.2, y: 0.2, w: 0.2 },
          { asset: 'a_upload', x: 0.8, y: 0.8, w: 0.1 },
        ],
        presenter_asset: 'a_presenter',
      },
      {
        id: 's_two',
        layout: 'hero',
        preferredFrames: 60,
        background: { asset: 'a_shared' },
        foreground: [{ asset: 'a_empty_gen', x: 0.5, y: 0.5, w: 0.3 }],
      },
      {
        id: 's_three',
        layout: 'hero',
        preferredFrames: 45,
        background: { asset: 'a_upload' },
        foreground: [],
      },
    ],
    assets: {
      a_bg: { kind: 'image', status: 'ready', gen: GEN },
      a_plate: { kind: 'video', status: 'ready', media: { fps: 24, frames: 48 }, gen: VIDEO_GEN },
      a_shared: { kind: 'image', status: 'ready', gen: GEN },
      a_presenter: { kind: 'video', status: 'ready', media: { fps: 30, frames: 90 }, gen: PRESENTER_GEN },
      a_upload: { kind: 'image', status: 'ready', origin: 'upload' },
      a_empty_gen: { kind: 'image', status: 'ready', gen: {} },
    },
  };
}

test('TR03: finds background, foreground and presenter slots with their kinds', () => {
  const pkg = makePackage();
  const timeline = compileTimeline(pkg);
  const clips = listClips(pkg);
  const scene = timeline.scenes.find((entry) => entry.id === 's_one');

  const bySlot = new Map(clips.filter((clip) => clip.sceneId === 's_one').map((clip) => [clip.slot, clip]));
  assert.equal(bySlot.size, 4);
  assert.deepEqual(bySlot.get('background'), {
    clipId: 's_one:a_bg',
    sceneId: 's_one',
    assetId: 'a_bg',
    slot: 'background',
    kind: 'still',
    from: scene.from,
    durationInFrames: scene.durationInFrames,
  });
  assert.equal(bySlot.get('foreground:0').assetId, 'a_plate');
  assert.equal(bySlot.get('foreground:0').kind, 'plate');
  assert.equal(bySlot.get('foreground:0').from, scene.from);
  assert.equal(bySlot.get('foreground:0').durationInFrames, scene.durationInFrames);
  assert.equal(bySlot.get('foreground:1').assetId, 'a_shared');
  assert.equal(bySlot.get('foreground:1').kind, 'still');
  assert.equal(bySlot.get('presenter').assetId, 'a_presenter');
  assert.equal(bySlot.get('presenter').kind, 'presenter');

  const second = timeline.scenes.find((entry) => entry.id === 's_two');
  const shared = clips.find((clip) => clip.clipId === 's_two:a_shared');
  assert.equal(shared.from, second.from);
  assert.equal(shared.durationInFrames, second.durationInFrames);
});

test('TR03: assets without gen.generator are excluded', () => {
  const pkg = makePackage();
  const assetIds = new Set(listClips(pkg).map((clip) => clip.assetId));
  assert.ok(!assetIds.has('a_upload'), 'an upload has no generator');
  assert.ok(!assetIds.has('a_empty_gen'), 'a gen block without a generator is not reviewable');
  assert.deepEqual(listClips(pkg, {}, { sceneId: 's_three' }), []);
  assert.deepEqual(listClips(pkg, 's_three'), []);
});

test('TR03: a shared asset yields two clipIds with one assetId', () => {
  const clips = listClips(makePackage());
  const shared = clips.filter((clip) => clip.assetId === 'a_shared');
  assert.equal(shared.length, 2);
  assert.deepEqual(shared.map((clip) => clip.clipId), ['s_one:a_shared', 's_two:a_shared']);
  assert.equal(new Set(shared.map((clip) => clip.assetId)).size, 1);
});

test('TR03: an unknown scene returns an empty list', () => {
  const pkg = makePackage();
  assert.deepEqual(listClips(pkg, {}, { sceneId: 's_missing' }), []);
  assert.deepEqual(listClips(pkg, {}, 's_missing'), []);
  assert.deepEqual(listClips(pkg, 's_missing'), []);
});

test('TR03: the measured narration is passed to the compiler', () => {
  const pkg = makePackage();
  const measured = { narration: { s_one: [{ text: 'A much longer line of narration.', seconds: 12 }] } };
  const timeline = compileTimeline(pkg, measured);
  const clips = listClips(pkg, measured);
  const scene = timeline.scenes.find((entry) => entry.id === 's_one');
  const background = clips.find((clip) => clip.clipId === 's_one:a_bg');
  assert.equal(background.from, scene.from);
  assert.equal(background.durationInFrames, scene.durationInFrames);
  assert.ok(background.durationInFrames > 90, 'measured speech extends the scene');
});

test('TR03: an empty package has no clips', () => {
  assert.deepEqual(listClips({ scenes: [], assets: {} }), []);
  assert.deepEqual(listClips(null), []);
});
