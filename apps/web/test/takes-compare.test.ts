// IL19F2: takes compare view. Node's test runner has no DOM, so these tests
// exercise the controller, the render contract and the CSS contract. The
// web package typecheck has no @types/node; node:test imports are runtime only.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMPARE_MAX_TAKES,
  CompareController,
  compareKeyMap,
  prefersReducedMotion,
  renderCompare,
  takeCompareLabel,
} from '../src/takes/compare.ts';
import { renderReviewDrawer } from '../src/takes/review-drawer.ts';

const PACKAGE_ID = 'pkg_demo';
const CLIP_ID = 's1:a_plate1';
const SHOT_ID = 's1:a_plate1';

function take(n, overrides = {}) {
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
    ...overrides,
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
    takeCount: 4,
    newTakes: 0,
    lastJob: null,
    queued: false,
    ...overrides,
  };
}

function fakeApi(options = {}) {
  const calls = { select: [] };
  let release = null;
  const api = {
    async select(packageId, clipId, takeId) {
      calls.select.push({ packageId, clipId, takeId });
      if (options.deferred) {
        await new Promise(resolve => { release = resolve; });
      }
      const result = {
        kind: 'selected',
        packageId,
        revision: 5,
        clip: { ...clip(1), selected: takeId },
        takeId,
      };
      if (options.omitTakeId) delete result.takeId;
      return result;
    },
  };
  return {
    api,
    calls,
    release() {
      if (release) release();
      release = null;
    },
  };
}

function controllerOptions(overrides = {}) {
  const fake = overrides.fake ?? fakeApi();
  return {
    fake,
    options: {
      api: fake.api,
      packageId: PACKAGE_ID,
      clipId: CLIP_ID,
      shotId: SHOT_ID,
      takes: [take(1), take(2), take(3)],
      selected: null,
      ...overrides.options,
    },
  };
}

test('labels read "Take n of m, shot <id>" and never use colour alone', () => {
  assert.equal(takeCompareLabel(1, 4, SHOT_ID), 'Take 1 of 4, shot s1:a_plate1');
  assert.equal(takeCompareLabel(3, 3, 's2:b_plate'), 'Take 3 of 3, shot s2:b_plate');

  const { options } = controllerOptions();
  const controller = new CompareController(options);
  const html = renderCompare(controller.state);

  assert.match(html, /data-compare-view/);
  assert.match(html, /aria-label="Take 1 of 3, shot s1:a_plate1"/);
  assert.match(html, /aria-label="Take 3 of 3, shot s1:a_plate1"/);
  assert.match(html, /data-compare-live[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /data-compare-status="focused"/);
  assert.match(html, /data-compare-status="kept"/);
  assert.match(html, /data-compare-status="pinned"/);
  assert.match(html, /<span class="compare-state-text">Focused<\/span>/);
});

test('two to four takes render side by side and roving tabindex follows focus', () => {
  assert.equal(COMPARE_MAX_TAKES, 4);
  const pair = new CompareController(controllerOptions({
    options: { takes: [take(1), take(2)] },
  }).options);
  assert.equal((renderCompare(pair.state).match(/data-compare-take=/g) ?? []).length, 2);
  const { options } = controllerOptions({
    options: { takes: [take(1), take(2), take(3), take(4), take(5)] },
  });
  const controller = new CompareController(options);
  assert.equal(controller.state.takes.length, 4);
  assert.equal((renderCompare(controller.state).match(/data-compare-take=/g) ?? []).length, 4);

  controller.focusTake(2);
  const html = renderCompare(controller.state);
  assert.equal(controller.state.focusIndex, 2);
  assert.match(html, /data-compare-take="tk_333333333333"[^>]*tabindex="0"/);
  assert.match(html, /data-compare-take="tk_111111111111"[^>]*tabindex="-1"/);
  assert.equal(controller.state.liveMessage, 'Take 3 of 4, shot s1:a_plate1');
});

test('the keyboard map focuses 1-4, plays and pauses all, keeps on Enter, moves shots and closes', async () => {
  const shots = [
    { shotId: 's1:a_plate1', clipId: 'c1', takes: [take(1), take(2)], selected: null },
    { shotId: 's2:a_plate2', clipId: 'c2', takes: [take(3), take(4)], selected: null },
  ];
  const fake = fakeApi();
  const closed = [];
  const { options } = controllerOptions({
    fake,
    options: {
      takes: [take(1), take(2)],
      shots,
      onClose: () => closed.push(true),
    },
  });
  const controller = new CompareController(options);

  assert.equal(compareKeyMap['1'], 'focus take 1');
  assert.equal(await controller.handleKey('2'), true);
  assert.equal(controller.state.focusIndex, 1);

  assert.equal(await controller.handleKey(' '), true);
  assert.equal(controller.state.playing, true);
  assert.equal(await controller.handleKey(' '), true);
  assert.equal(controller.state.playing, false);

  assert.equal(await controller.handleKey(']'), true);
  assert.equal(controller.state.shotId, 's2:a_plate2');
  assert.deepEqual(controller.state.takes.map(item => item.takeId), [
    'tk_333333333333',
    'tk_444444444444',
  ]);
  assert.equal(controller.state.focusIndex, 0);

  assert.equal(await controller.handleKey('['), true);
  assert.equal(controller.state.shotId, 's1:a_plate1');

  assert.equal(await controller.handleKey('3'), false);
  assert.equal(await controller.handleKey('Enter'), true);
  assert.equal(fake.calls.select.length, 1);
  assert.equal(fake.calls.select[0].takeId, 'tk_111111111111');

  assert.equal(await controller.handleKey('Escape'), true);
  assert.equal(closed.length, 1);
});

test('one shared play and scrub state keeps every take in sync', () => {
  const { options } = controllerOptions();
  const controller = new CompareController(options);

  controller.togglePlayback();
  assert.equal(controller.state.playing, true);
  controller.scrubTo(0.25);
  assert.equal(controller.state.position, 0.25);
  controller.scrubTo(4);
  assert.equal(controller.state.position, 1);
  controller.scrubTo(-3);
  assert.equal(controller.state.position, 0);

  const html = renderCompare(controller.state);
  assert.match(html, /data-compare-play[^>]*aria-pressed="true"/);
  assert.match(html, /data-compare-scrub[^>]*value="0"/);
  assert.match(html, /data-compare-position="0"/);
  assert.match(html, /Pause all/);
});

test('Keep calls the existing take select API once; Keep both for later only pins', async () => {
  const fake = fakeApi({ deferred: true });
  const { options } = controllerOptions({ fake });
  const controller = new CompareController(options);

  assert.equal(controller.pinFocused(), true);
  assert.equal(fake.calls.select.length, 0);
  assert.equal(controller.state.pinned.size, 1);
  assert.equal(controller.state.selected, null);
  assert.match(renderCompare(controller.state), /data-compare-pin[^>]*aria-pressed="true"/);

  const first = controller.keepFocused();
  const second = controller.keepFocused();
  assert.equal(await second, false);
  fake.release();
  assert.equal(await first, true);
  assert.equal(fake.calls.select.length, 1);
  assert.deepEqual(fake.calls.select[0], {
    packageId: PACKAGE_ID,
    clipId: CLIP_ID,
    takeId: 'tk_111111111111',
  });
  assert.equal(controller.state.selected, 'tk_111111111111');
  assert.match(controller.state.liveMessage, /^Kept Take 1 of 3, shot s1:a_plate1/);

  assert.equal(controller.pinFocused(), true);
  assert.equal(fake.calls.select.length, 1);
  assert.equal(controller.state.pinned.size, 0);
});

test('Keep without a server-confirmed takeId leaves no take kept and announces the failure', async () => {
  const fake = fakeApi({ omitTakeId: true });
  const { options } = controllerOptions({ fake });
  const controller = new CompareController(options);

  const kept = await controller.keepFocused();

  assert.equal(kept, false);
  assert.equal(fake.calls.select.length, 1);
  assert.equal(controller.state.selected, null);
  assert.equal(controller.state.takes.some(item => item.takeId === controller.state.selected), false);
  assert.equal(controller.state.keepError, 'Keep failed: the server did not confirm the take');
  assert.match(controller.state.liveMessage, /Keep failed: the server did not confirm the take/);

  const html = renderCompare(controller.state);
  assert.doesNotMatch(html, /class="compare-take[^"]*is-kept/);
  assert.match(html, /data-compare-error[^>]*role="alert"[^>]*>Keep failed: the server did not confirm the take</);
});

test('difference and safe-area toggles are announced and rendered as pattern plus text', () => {
  const { options } = controllerOptions();
  const controller = new CompareController(options);

  controller.toggleDifference();
  controller.toggleSafeArea();
  assert.equal(controller.state.showDifference, true);
  assert.equal(controller.state.showSafeArea, true);
  assert.match(controller.state.liveMessage, /Difference overlay on/);

  const html = renderCompare(controller.state);
  assert.match(html, /data-compare-difference[^>]*aria-pressed="true"/);
  assert.match(html, /data-compare-safe-area[^>]*aria-pressed="true"/);
  assert.match(html, /data-difference="on"/);
  assert.match(html, /data-safe-area="on"/);
  assert.match(html, /compare-overlay-difference[^>]*>Difference overlay</);
  assert.match(html, /compare-overlay-safe-area[^>]*>Safe area</);
});

test('reduced motion is respected by the runtime helper and the stylesheet', () => {
  const media = { matches: true, addEventListener() {}, removeEventListener() {} };
  assert.equal(prefersReducedMotion(() => media), true);
  assert.equal(prefersReducedMotion(() => ({ ...media, matches: false })), false);
  assert.equal(prefersReducedMotion(null), false);

  const css = readFileSync(new URL('../src/takes/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.compare-view\b/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.compare-view/);
});

test('the review drawer has exactly one Compare entry button', () => {
  const html = renderReviewDrawer([clip(1), clip(2)], { open: true });
  assert.equal((html.match(/data-review-compare/g) ?? []).length, 1);
  assert.match(html, /data-review-compare[^>]*aria-haspopup="dialog"/);
  assert.match(html, />Compare</);
});

test('the Compare entry dispatches only the real clip id in its event detail', async () => {
  const drawer = await import('../src/takes/review-drawer.ts');
  assert.equal(typeof drawer.reviewCompareEventDetail, 'function');

  const detail = drawer.reviewCompareEventDetail(clip(1));
  assert.deepEqual(detail, { clipId: 's1:a_plate1' });
  assert.equal('shotId' in detail, false);
  assert.equal(detail.shotId, undefined);
});

test('a controller requires an explicit non-empty shotId', () => {
  const { options } = controllerOptions();
  assert.throws(
    () => new CompareController({ ...options, shotId: undefined }),
    (error) => error instanceof TypeError && /requires a shotId/.test(error.message),
  );
  assert.throws(
    () => new CompareController({ ...options, shotId: '' }),
    (error) => error instanceof TypeError && /requires a shotId/.test(error.message),
  );
  assert.throws(
    () => new CompareController({ ...options, shotId: 7 }),
    (error) => error instanceof TypeError && /requires a shotId/.test(error.message),
  );
});

test('a shots entry without its own clipId is dropped and never used as a clip id', async () => {
  const fake = fakeApi();
  const { options } = controllerOptions({
    fake,
    options: {
      takes: [take(1), take(2)],
      shots: [
        { shotId: 's1:a_plate1', clipId: 'c1', takes: [take(1), take(2)] },
        { shotId: 's9:x', takes: [take(3), take(4)] },
      ],
    },
  });
  const controller = new CompareController(options);

  assert.deepEqual(controller.state.shots.map(shot => shot.shotId), ['s1:a_plate1']);
  assert.equal(await controller.handleKey(']'), false);
  assert.equal(controller.state.shotId, 's1:a_plate1');
  assert.equal(await controller.handleKey('['), false);
  assert.equal(controller.state.shotId, 's1:a_plate1');

  assert.equal(await controller.handleKey('Enter'), true);
  assert.equal(fake.calls.select.length, 1);
  assert.equal(fake.calls.select[0].clipId, 'c1');
  assert.equal(fake.calls.select.every(call => call.clipId !== 's9:x'), true);
});
