// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline } from '../../../packages/planner/dist/src/browser.js';
import { previewPackage } from '../src/takes/preview-takes.ts';

const SELECTED_TAKE = 'tk_aaaaaaaaaaaa';
const AB_TAKE = 'tk_bbbbbbbbbbbb';
const OTHER_TAKE = 'tk_cccccccccccc';
const SELECTED_URL = '/api/media/selected_ticket';
const AB_URL = '/api/media/ab_ticket';
const OTHER_URL = '/api/media/other_ticket';

function fixture() {
  return {
    schemaVersion: 1,
    id: 'pkg_preview',
    title: 'Preview fixture',
    revision: 3,
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible' },
    scenes: [
      {
        id: 's1',
        layout: 'hero',
        preferredFrames: 60,
        background: { asset: 'a_plate' },
      },
      {
        id: 's2',
        layout: 'stat',
        preferredFrames: 90,
        background: { asset: 'a_other' },
      },
    ],
    assets: {
      a_plate: {
        kind: 'video',
        origin: 'generated',
        status: 'ready',
        file: 'assets/a_plate.mp4',
        sha256: '1'.repeat(64),
        bytes: 2048,
        media: { fps: 24, frames: 48, width: 1280, height: 720 },
        gen: { generator: 'comfyui', prompt: 'a calm plate', seed: 7 },
      },
      a_other: {
        kind: 'video',
        origin: 'generated',
        status: 'ready',
        file: 'assets/a_other.mp4',
        sha256: '2'.repeat(64),
        bytes: 4096,
        media: { fps: 30, frames: 30, width: 1280, height: 720 },
        gen: { generator: 'comfyui', prompt: 'another plate', seed: 9 },
      },
    },
  };
}

function clips() {
  return [
    {
      clipId: 's1:a_plate',
      assetId: 'a_plate',
      selected: SELECTED_TAKE,
      takes: [
        {
          takeId: SELECTED_TAKE,
          url: SELECTED_URL,
          media: { fps: 24, frames: 50, width: 1280, height: 720 },
        },
        {
          takeId: AB_TAKE,
          url: AB_URL,
          media: { fps: 24, frames: 72, width: 1920, height: 1080 },
        },
      ],
    },
    {
      clipId: 's2:a_other',
      assetId: 'a_other',
      selected: OTHER_TAKE,
      takes: [
        {
          takeId: OTHER_TAKE,
          url: OTHER_URL,
          media: { fps: 30, frames: 30, width: 1280, height: 720 },
        },
      ],
    },
  ];
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sceneTiming(timeline) {
  return timeline.scenes.map(scene => ({
    id: scene.id,
    from: scene.from,
    durationInFrames: scene.durationInFrames,
    transitionInFrames: scene.transitionInFrames,
    transitionOutFrames: scene.transitionOutFrames,
  }));
}

test('previewPackage swaps the selected take file and media without mutating the package', () => {
  const pkg = deepFreeze(fixture());
  const before = structuredClone(pkg);

  const preview = previewPackage(pkg, clips());

  assert.notEqual(preview, pkg);
  assert.equal(preview.assets.a_plate.file, SELECTED_URL);
  assert.deepEqual(preview.assets.a_plate.media, { fps: 24, frames: 50, width: 1280, height: 720 });
  assert.equal(preview.assets.a_other.file, OTHER_URL);
  assert.deepEqual(preview.assets.a_other.media, { fps: 30, frames: 30, width: 1280, height: 720 });
  assert.deepEqual(pkg, before);

  const { file: previewFile, media: previewMedia, ...previewRest } = preview.assets.a_plate;
  const { file: originalFile, media: originalMedia, ...originalRest } = pkg.assets.a_plate;
  assert.equal(originalFile, 'assets/a_plate.mp4');
  assert.deepEqual(originalMedia, { fps: 24, frames: 48, width: 1280, height: 720 });
  assert.deepEqual(previewRest, originalRest);
  assert.equal(previewFile, SELECTED_URL);
  assert.notDeepEqual(previewMedia, originalMedia);
});

test('compiling the preview keeps every scene from and duration unchanged', () => {
  const pkg = fixture();
  const base = compileTimeline(pkg);
  const candidate = compileTimeline(previewPackage(pkg, clips(), { abTake: AB_TAKE }));

  assert.deepEqual(sceneTiming(candidate), sceneTiming(base));
  assert.equal(candidate.durationInFrames, base.durationInFrames);
});

test('A/B selects the candidate take only for the named clip and clearing it restores selected', () => {
  const pkg = fixture();

  const a = previewPackage(pkg, clips(), { abTake: AB_TAKE });
  assert.equal(a.assets.a_plate.file, AB_URL);
  assert.deepEqual(a.assets.a_plate.media, { fps: 24, frames: 72, width: 1920, height: 1080 });
  assert.equal(a.assets.a_other.file, OTHER_URL);

  const targeted = previewPackage(pkg, clips(), {
    abTake: { clipId: 's1:a_plate', assetId: 'a_plate', takeId: AB_TAKE },
  });
  assert.equal(targeted.assets.a_plate.file, AB_URL);
  assert.equal(targeted.assets.a_other.file, OTHER_URL);

  const wrongClip = previewPackage(pkg, clips(), { abTake: { clipId: 's2:a_other', takeId: AB_TAKE } });
  assert.equal(wrongClip.assets.a_plate.file, SELECTED_URL);
  assert.equal(wrongClip.assets.a_other.file, OTHER_URL);

  const cleared = previewPackage(pkg, clips(), { abTake: null });
  assert.equal(cleared.assets.a_plate.file, SELECTED_URL);
  assert.deepEqual(cleared.assets.a_plate.media, { fps: 24, frames: 50, width: 1280, height: 720 });

  const missing = previewPackage(pkg, clips(), { abTake: 'tk_ffffffffffff' });
  assert.equal(missing.assets.a_plate.file, SELECTED_URL);
});

test('only the assigned asset files change', () => {
  const pkg = deepFreeze(fixture());
  const onlyPlate = clips().filter(clip => clip.assetId === 'a_plate');

  const preview = previewPackage(pkg, onlyPlate);

  assert.deepEqual(preview.assets.a_other, pkg.assets.a_other);
  assert.equal(preview.assets.a_plate.file, SELECTED_URL);
  assert.equal(preview.scenes[1].background.asset, 'a_other');
  assert.deepEqual(sceneTiming(compileTimeline(preview)), sceneTiming(compileTimeline(pkg)));
});

test('accepts asset-keyed clips and direct take assignments', () => {
  const pkg = fixture();
  const keyed = previewPackage(pkg, {
    a_plate: { selected: SELECTED_TAKE, takes: [{ takeId: SELECTED_TAKE, url: SELECTED_URL }] },
    a_other: { selected: OTHER_TAKE, takes: [{ takeId: OTHER_TAKE, url: OTHER_URL }] },
  });
  assert.equal(keyed.assets.a_plate.file, SELECTED_URL);
  assert.equal(keyed.assets.a_other.file, OTHER_URL);

  const direct = previewPackage(pkg, [
    { clipId: 's1:a_plate', assetId: 'a_plate', selected: SELECTED_TAKE, takeId: SELECTED_TAKE, url: AB_URL },
  ]);
  assert.equal(direct.assets.a_plate.file, AB_URL);
});

test('an unsafe ticket URL is ignored and never copied into the preview package', () => {
  const pkg = fixture();
  const marker = 'leak_marker';
  const unsafe = [
    {
      clipId: 's1:a_plate',
      assetId: 'a_plate',
      selected: SELECTED_TAKE,
      takes: [
        { takeId: SELECTED_TAKE, url: `/api/media/selected_ticket?auth=${marker}` },
        { takeId: AB_TAKE, url: `https://example.invalid/media/${marker}` },
      ],
    },
  ];

  const preview = previewPackage(pkg, unsafe, { abTake: AB_TAKE });

  assert.equal(preview.assets.a_plate.file, 'assets/a_plate.mp4');
  assert.equal(JSON.stringify(preview).includes(marker), false);
});
