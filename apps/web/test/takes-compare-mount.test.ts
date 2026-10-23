// IL24: the review drawer's Compare button opens the IL19F2 compare view with
// the package scene id as the shot id (never the clip id). Node's test runner
// has no DOM library, so the mount contract is a pure helper plus source-shape
// checks on the two mount sites.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as renderBarModule from '../src/takes/render-bar.ts';

const PACKAGE_ID = 'pkg_demo';

function take(n) {
  return {
    takeId: `tk_${String(n).repeat(12)}`,
    assetId: 'a_plate1',
    n,
    file: `takes/a_plate1/take-${n}.mp4`,
    sha256: String(n).repeat(64),
    bytes: 1024 * n,
    media: { fps: 24, frames: 48, durationInSeconds: 2 },
    gen: { generator: 'comfyui', prompt: `plate take ${n}`, seed: 7 + n },
    createdAt: `2026-10-20T12:0${n}:00.000Z`,
    verdict: 'unreviewed',
  };
}

function clip(n, overrides = {}) {
  return {
    clipId: `s${n}:a_plate${n}`,
    sceneId: `s${n}`,
    assetId: `a_plate${n}`,
    slot: 'background',
    kind: 'plate',
    from: (n - 1) * 90,
    durationInFrames: 90,
    state: 'review',
    selected: `tk_${String(n).repeat(12)}`,
    selectedN: 1,
    takeCount: 2,
    newTakes: 0,
    lastJob: null,
    queued: false,
    ...overrides,
  };
}

function takesResponse(overrides = {}) {
  return {
    packageId: PACKAGE_ID,
    revision: 7,
    clip: clip(1, { selected: 'tk_222222222222' }),
    assetId: 'a_plate1',
    selected: 'tk_222222222222',
    takes: [take(1), take(2)],
    history: [],
    lastJob: null,
    queued: null,
    ...overrides,
  };
}

function fakeApi(response = takesResponse()) {
  const calls = { getTakes: [], select: [], takeUrl: [] };
  return {
    calls,
    api: {
      async getTakes(packageId, clipId) {
        calls.getTakes.push({ packageId, clipId });
        return response;
      },
      async select(packageId, clipId, takeId) {
        calls.select.push({ packageId, clipId, takeId });
        return { kind: 'selected', packageId, revision: 8, clip: clip(1), takeId };
      },
      async takeUrl(packageId, clipId, takeId) {
        calls.takeUrl.push({ packageId, clipId, takeId });
        return `/api/media/${takeId}`;
      },
    },
  };
}

function compareOptionsForClip(...args) {
  assert.equal(
    typeof renderBarModule.compareOptionsForClip,
    'function',
    'render-bar must export compareOptionsForClip',
  );
  return renderBarModule.compareOptionsForClip(...args);
}

test('compare options use the scene id as shotId and keep the clip id separate', () => {
  const active = clip(1);
  const fake = fakeApi();
  const options = compareOptionsForClip(active, [active], takesResponse(), PACKAGE_ID, fake.api);

  assert.ok(options);
  assert.equal(options.shotId, active.sceneId);
  assert.equal(options.shotId, 's1');
  assert.equal(options.clipId, active.clipId);
  assert.equal(options.clipId, 's1:a_plate1');
  assert.notEqual(options.shotId, options.clipId);
  assert.equal(options.packageId, PACKAGE_ID);
  assert.equal(options.api, fake.api);
});

test('compare options map every clip to a sceneId/clipId shot pair and skip empty scene ids', () => {
  const active = clip(1);
  const clips = [
    clip(1),
    clip(2),
    clip(3, { clipId: 'c_unscened', sceneId: '' }),
    clip(4, { clipId: 'c_blank', sceneId: '   ' }),
  ];
  const options = compareOptionsForClip(active, clips, takesResponse(), PACKAGE_ID, fakeApi().api);

  assert.ok(options);
  assert.deepEqual(options.shots, [
    { shotId: 's1', clipId: 's1:a_plate1' },
    { shotId: 's2', clipId: 's2:a_plate2' },
  ]);
});

test('compare options carry the response selected take and takes unchanged', () => {
  const active = clip(1);
  const response = takesResponse();
  const options = compareOptionsForClip(active, [active], response, PACKAGE_ID, fakeApi(response).api);

  assert.ok(options);
  assert.equal(options.selected, response.selected);
  assert.equal(options.selected, 'tk_222222222222');
  assert.equal(options.takes, response.takes);
});

test('compare options are null when the clip has no scene id', () => {
  const active = clip(1, { sceneId: '' });
  assert.equal(compareOptionsForClip(active, [active], takesResponse(), PACKAGE_ID, fakeApi().api), null);

  const blank = clip(1, { sceneId: '   ' });
  assert.equal(compareOptionsForClip(blank, [blank], takesResponse(), PACKAGE_ID, fakeApi().api), null);
});

test('render-bar passes onCompare only when the compare option is given', () => {
  const source = readFileSync(new URL('../src/takes/render-bar.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /compare\?:\s*\{[\s\S]*?api:\s*Pick<TakesApi,\s*'getTakes'\s*\|\s*'select'\s*\|\s*'takeUrl'>[\s\S]*?packageId:\s*\(\)\s*=>\s*string/,
    'RenderBarMountOptions must accept one compare option',
  );
  assert.match(
    source,
    /\.\.\.\(options\.compare\s*\?\s*\{\s*onCompare/,
    'onCompare must be passed to the drawer only when compare is given',
  );
  assert.doesNotMatch(
    source,
    /onCompare:\s*options\.[A-Za-z]/,
    'the drawer must not receive an unconditional onCompare',
  );
  assert.match(source, /compareOptionsForClip\(/, 'the mount path must use the shared pure helper');
  assert.match(source, /mountCompare\(/, 'the render bar must mount the IL19F2 compare view');
  assert.match(source, /\[data-review-compare\]/, 'closing compare must return focus to the drawer Compare button');
});

test('main.ts passes the takes API and package id to mountRenderBar compare', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /renderBar = mountRenderBar\(renderBarHost, \{[\s\S]*?compare:\s*\{[\s\S]*?api:\s*takesApi,[\s\S]*?packageId:\s*\(\)\s*=>\s*String\(pkg\.id \?\? ''\)/,
    'main.ts must pass compare: { api: takesApi, packageId } to mountRenderBar',
  );
});

test('after a Keep the drawer refreshes the clip compare is on, not the clip it opened with', () => {
  const source = readFileSync(new URL('../src/takes/render-bar.ts', import.meta.url), 'utf8');
  assert.match(source, /refreshDrawerAfterKeep\(state\.clipId, state\.packageId\)/);
  assert.doesNotMatch(source, /refreshDrawerAfterKeep\(clip\.clipId/);
});
