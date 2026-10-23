import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_BINDINGS,
  KIND_CAPABILITIES,
  clampRegion,
  displayedToMediaRegion,
  handleKey,
  markIn,
  markOut,
  moveRegion,
  nextViewer,
  normalizeTime,
  openViewer,
  prevViewer,
  resizeRegion,
  resolveKey,
  setTimeAt,
  setTimeRange,
  validTimeRange,
} from '../src/viewer/model.ts';
import type { ViewerItem } from '../src/viewer/model.ts';

const ITEMS: ViewerItem[] = [
  { id: 'a_img', kind: 'image', title: 'Still', width: 1920, height: 1080 },
  { id: 'a_vid', kind: 'video', title: 'Take', duration: 10, fps: 10, width: 1920, height: 1080 },
  { id: 'a_aud', kind: 'audio', title: 'Voice', duration: 20 },
  { id: 'a_txt', kind: 'text', title: 'Notes' },
];

function close(actual: number, expected: number, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

function closeRegion(actual: { x: number; y: number; w: number; h: number }, expected: { x: number; y: number; w: number; h: number }) {
  close(actual.x, expected.x);
  close(actual.y, expected.y);
  close(actual.w, expected.w);
  close(actual.h, expected.h);
}

test('openViewer opens at a clamped index and reports both ends', () => {
  const empty = openViewer([], 0);
  assert.equal(empty.open, false);
  assert.equal(empty.index, -1);
  assert.equal(empty.item, null);
  assert.equal(empty.kind, null);
  assert.equal(empty.canPrev, false);
  assert.equal(empty.canNext, false);

  const first = openViewer(ITEMS, 0);
  assert.equal(first.open, true);
  assert.equal(first.index, 0);
  assert.equal(first.item?.id, 'a_img');
  assert.equal(first.kind, 'image');
  assert.equal(first.canPrev, false);
  assert.equal(first.canNext, true);

  const last = openViewer(ITEMS, 99);
  assert.equal(last.index, 3);
  assert.equal(last.kind, 'text');
  assert.equal(last.canNext, false);
  assert.equal(last.canPrev, true);

  assert.equal(openViewer(ITEMS, -4).index, 0);
});

test('next and prev never wrap around and are disabled at the ends', () => {
  const first = openViewer(ITEMS, 0);
  assert.equal(prevViewer(first), first);
  const second = nextViewer(first);
  assert.equal(second.index, 1);
  assert.equal(second.kind, 'video');
  assert.equal(second.canPrev, true);
  assert.equal(second.canNext, true);

  const last = openViewer(ITEMS, 3);
  assert.equal(nextViewer(last), last);
  assert.equal(prevViewer(last).index, 2);

  assert.equal(resolveKey(last, 'ArrowRight'), null);
  assert.equal(resolveKey(first, 'ArrowLeft'), null);
  assert.equal(resolveKey(first, 'ArrowRight'), 'next');
});

test('kind dispatch exposes capabilities for image, video, audio and text', () => {
  assert.deepEqual(KIND_CAPABILITIES.image, { time: false, region: true, playback: false, frameStep: false });
  assert.deepEqual(KIND_CAPABILITIES.video, { time: true, region: true, playback: true, frameStep: true });
  assert.deepEqual(KIND_CAPABILITIES.audio, { time: true, region: false, playback: true, frameStep: false });
  assert.deepEqual(KIND_CAPABILITIES.text, { time: false, region: false, playback: false, frameStep: false });

  for (const item of ITEMS) {
    assert.equal(openViewer([item], 0).kind, item.kind);
  }
});

test('the keyboard map is a table and resolves every documented shortcut', () => {
  assert.ok(Array.isArray(KEY_BINDINGS));
  assert.ok(KEY_BINDINGS.length >= 14);

  const video = openViewer(ITEMS, 1);
  const cases: Array<[string, boolean, string | null]> = [
    ['ArrowLeft', false, 'prev'],
    ['ArrowRight', false, 'next'],
    [' ', false, 'togglePlay'],
    ['j', false, 'seekBack'],
    ['k', false, 'togglePlay'],
    ['l', false, 'seekForward'],
    [',', false, 'frameBack'],
    ['.', false, 'frameForward'],
    ['i', false, 'markIn'],
    ['o', false, 'markOut'],
    ['r', false, 'toggleRegion'],
    ['e', false, 'iterate'],
    ['c', false, 'toggleCompare'],
    ['Escape', false, 'close'],
    ['K', false, 'togglePlay'],
  ];
  for (const [key, shift, command] of cases) {
    assert.equal(resolveKey(video, key, shift), command, key);
  }
});

test('keyboard dispatch respects kind capabilities', () => {
  const image = openViewer(ITEMS, 0);
  assert.equal(resolveKey(image, ' '), null);
  assert.equal(resolveKey(image, ','), null);
  assert.equal(resolveKey(image, 'i'), null);
  assert.equal(resolveKey(image, 'r'), 'toggleRegion');

  const audio = openViewer(ITEMS, 2);
  assert.equal(resolveKey(audio, 'r'), null);
  assert.equal(resolveKey(audio, ','), null);
  assert.equal(resolveKey(audio, 'i'), 'markIn');
  assert.equal(resolveKey(audio, ' '), 'togglePlay');

  const text = openViewer(ITEMS, 3);
  assert.equal(resolveKey(text, 'e'), 'iterate');
  assert.equal(resolveKey(text, 'c'), 'toggleCompare');
  assert.equal(resolveKey(text, 'i'), null);
  assert.equal(resolveKey(text, 'r'), null);
});

test('handleKey applies navigation, playback, compare, iterate and close', () => {
  const video = openViewer(ITEMS, 1);
  const advanced = handleKey(video, '.');
  assert.equal(advanced.command, 'frameForward');
  close(advanced.state.time, 0.1);

  const playing = handleKey(advanced.state, ' ');
  assert.equal(playing.state.playing, true);
  const paused = handleKey(playing.state, 'k');
  assert.equal(paused.state.playing, false);

  const sought = handleKey(video, 'l');
  close(sought.state.time, 5);
  close(handleKey(sought.state, 'j').state.time, 0);

  const compared = handleKey(video, 'c');
  assert.equal(compared.state.compare, true);
  assert.equal(handleKey(compared.state, 'c').state.compare, false);

  const iterated = handleKey(video, 'e');
  assert.equal(iterated.command, 'iterate');
  assert.equal(iterated.state.open, true);
  assert.equal(iterated.state.annotation.time, undefined);

  const closed = handleKey(video, 'Escape');
  assert.equal(closed.state.open, false);
  assert.equal(resolveKey(closed.state, 'ArrowRight'), null);
});

test('frame stepping clamps to the media duration', () => {
  const image = openViewer(ITEMS, 0);
  assert.equal(handleKey(image, '.').command, null);
  assert.equal(handleKey(image, '.').state.time, 0);

  const end = { ...openViewer(ITEMS, 1), time: 9.99 };
  close(handleKey(end, '.').state.time, 10);
  const start = { ...openViewer(ITEMS, 1), time: 0.02 };
  close(handleKey(start, ',').state.time, 0);
});

test('region mode starts a centred region and arrows move it by one percent', () => {
  const video = openViewer(ITEMS, 1);
  const regionMode = handleKey(video, 'r').state;
  assert.equal(regionMode.regionMode, true);
  closeRegion(regionMode.annotation.region!, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });

  const right = handleKey(regionMode, 'ArrowRight').state;
  closeRegion(right.annotation.region!, { x: 0.26, y: 0.25, w: 0.5, h: 0.5 });
  const down = handleKey(right, 'ArrowDown').state;
  closeRegion(down.annotation.region!, { x: 0.26, y: 0.26, w: 0.5, h: 0.5 });

  assert.equal(resolveKey(regionMode, 'ArrowRight'), 'regionMoveRight');
  assert.equal(resolveKey(regionMode, 'ArrowRight', true), 'regionGrowWidth');
  assert.equal(resolveKey(regionMode, 'ArrowLeft', true), 'regionShrinkWidth');
  assert.equal(resolveKey(regionMode, 'ArrowUp', true), 'regionGrowHeight');
  assert.equal(resolveKey(regionMode, 'ArrowDown', true), 'regionShrinkHeight');
});

test('region movement and resizing clamp inside the media box', () => {
  const topLeft = { x: 0, y: 0, w: 0.2, h: 0.2 };
  closeRegion(moveRegion(topLeft, -0.01, -0.01), topLeft);
  closeRegion(resizeRegion(topLeft, 0.01, 0.01), { x: 0, y: 0, w: 0.21, h: 0.21 });

  const bottomRight = { x: 0.8, y: 0.8, w: 0.2, h: 0.2 };
  closeRegion(moveRegion(bottomRight, 0.5, 0.5), bottomRight);
  closeRegion(resizeRegion(bottomRight, 0.5, 0.5), bottomRight);

  closeRegion(clampRegion({ x: 0.9, y: 0.8, w: 0.4, h: 0.5 }), { x: 0.9, y: 0.8, w: 0.1, h: 0.2 });
  closeRegion(clampRegion({ x: -0.2, y: -0.1, w: 0.5, h: 0.3 }), { x: 0, y: 0, w: 0.3, h: 0.2 });
});

test('keyboard shift resizing grows and shrinks width and height', () => {
  const video = openViewer(ITEMS, 1);
  const regionMode = handleKey(video, 'r').state;

  closeRegion(handleKey(regionMode, 'ArrowLeft', true).state.annotation.region!, { x: 0.25, y: 0.25, w: 0.49, h: 0.5 });
  closeRegion(handleKey(regionMode, 'ArrowRight', true).state.annotation.region!, { x: 0.25, y: 0.25, w: 0.51, h: 0.5 });
  closeRegion(handleKey(regionMode, 'ArrowUp', true).state.annotation.region!, { x: 0.25, y: 0.25, w: 0.5, h: 0.51 });
  closeRegion(handleKey(regionMode, 'ArrowDown', true).state.annotation.region!, { x: 0.25, y: 0.25, w: 0.5, h: 0.49 });
});

test('letterbox mapping converts a displayed region to normalised media coordinates', () => {
  const display = { x: 0, y: 0, width: 1000, height: 1000 };
  const wide = { width: 1920, height: 1080 };
  const mapped = displayedToMediaRegion({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, display, wide);
  close(mapped.x, 0.25);
  close(mapped.y, 0.05555555555555555);
  close(mapped.w, 0.5);
  close(mapped.h, 0.8888888888888888);

  const square = { width: 1000, height: 1000 };
  const short = { x: 0, y: 0, width: 1000, height: 500 };
  closeRegion(displayedToMediaRegion({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, short, square), { x: 0, y: 0.25, w: 1, h: 0.5 });
  closeRegion(displayedToMediaRegion({ x: 0, y: 0, w: 1, h: 1 }, display, wide), { x: 0, y: 0, w: 1, h: 1 });
  closeRegion(displayedToMediaRegion({ x: 0, y: 0, w: 1, h: 1 }, short, square), { x: 0, y: 0, w: 1, h: 1 });
});

test('time annotations clamp to the duration', () => {
  assert.deepEqual(setTimeAt({}, 4, 10), { time: { at: 4 } });
  assert.deepEqual(setTimeAt({}, 99, 10), { time: { at: 10 } });
  assert.deepEqual(setTimeAt({}, -2, 10), { time: { at: 0 } });

  assert.deepEqual(setTimeRange({}, { in: 2, out: 8 }, 10), { time: { in: 2, out: 8 } });
  assert.deepEqual(setTimeRange({}, { in: -5, out: 99 }, 10), { time: { in: 0, out: 10 } });
  assert.deepEqual(normalizeTime({ in: 8, out: 2 }, 10), { in: 2, out: 8 });

  const equal = normalizeTime({ in: 5, out: 5 }, 10);
  assert.ok(equal.in < equal.out);
  assert.ok(equal.in >= 0 && equal.out <= 10);

  const end = normalizeTime({ in: 10, out: 10 }, 10);
  assert.ok(end.in < end.out);
  assert.equal(end.out, 10);
});

test('time range validation rejects unordered, empty and out-of-duration ranges', () => {
  assert.equal(validTimeRange({ in: 0, out: 10 }, 10), true);
  assert.equal(validTimeRange({ in: 2, out: 8 }, 10), true);
  assert.equal(validTimeRange({ in: 5, out: 5 }, 10), false);
  assert.equal(validTimeRange({ in: 6, out: 5 }, 10), false);
  assert.equal(validTimeRange({ in: -1, out: 5 }, 10), false);
  assert.equal(validTimeRange({ in: 0, out: 11 }, 10), false);
  assert.equal(validTimeRange({ in: 0, out: 10 }, Number.NaN), false);
});

test('marking in and out produces an ordered range inside the duration', () => {
  const markedIn = markIn({}, 4, 10);
  assert.deepEqual(markedIn, { time: { in: 4, out: 10 } });

  const markedOut = markOut(markedIn, 7, 10);
  assert.deepEqual(markedOut, { time: { in: 4, out: 7 } });

  const clampedIn = markIn({}, -3, 10);
  assert.deepEqual(clampedIn, { time: { in: 0, out: 10 } });

  const clampedOut = markOut({}, 99, 10);
  assert.deepEqual(clampedOut, { time: { in: 0, out: 10 } });

  const crossed = markIn({ time: { in: 2, out: 5 } }, 8, 10);
  const crossedTime = crossed.time as { in: number; out: number };
  assert.ok(crossedTime.in < crossedTime.out);
  assert.ok(crossedTime.out <= 10);

  const video = openViewer(ITEMS, 1);
  const afterIn = handleKey({ ...video, time: 3 }, 'i').state;
  assert.deepEqual(afterIn.annotation.time, { in: 3, out: 10 });
  const afterOut = handleKey({ ...afterIn, time: 6 }, 'o').state;
  assert.deepEqual(afterOut.annotation.time, { in: 3, out: 6 });
});
