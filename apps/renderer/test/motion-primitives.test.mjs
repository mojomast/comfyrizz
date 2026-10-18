// MS1: entry/exit primitives. Checks the board acceptance: an entry settles at rest, an exit is
// 50-75% of its entry, nothing starts at partial opacity, and output is deterministic per frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countUp, enterExit, exitDuration, exitFade, fadeUp, maskRise, pop } from '../src/motion/primitives.js';

const FPS = 30;

test('MS1: fadeUp starts at 0 opacity and settles exactly at rest', () => {
  const start = fadeUp({ frame: 0, fps: FPS, delay: 0, duration: 18 });
  assert.equal(start.opacity, 0, 'starts fully transparent, not at 0.18');
  assert.equal(start.translateY, 42);
  for (const frame of [18, 19, 40, 200]) {
    const settled = fadeUp({ frame, fps: FPS, delay: 0, duration: 18 });
    assert.equal(settled.opacity, 1, `frame ${frame} is opaque`);
    assert.equal(settled.translateY, 0, `frame ${frame} is at rest`);
  }
  const mid = fadeUp({ frame: 6, fps: FPS, delay: 0, duration: 18 });
  assert.ok(mid.opacity > 0 && mid.opacity < 1, 'mid-entry is between');
  assert.deepEqual(fadeUp({ frame: 6, fps: FPS }), fadeUp({ frame: 6, fps: FPS }), 'deterministic');
});

test('MS1: fadeUp exit is 50-75% of the entry and ends at 0 opacity', () => {
  const entry = 20;
  const exit = exitDuration(entry);
  assert.ok(exit >= entry * 0.5 && exit <= entry * 0.75);
  const at = 100;
  const beforeExit = fadeUp({ frame: at, fps: FPS, duration: entry, exit: { at } });
  assert.equal(beforeExit.opacity, 1, 'still opaque when the exit starts');
  const afterExit = fadeUp({ frame: at + exit, fps: FPS, duration: entry, exit: { at } });
  assert.equal(afterExit.opacity, 0, 'fully gone after the exit');
  const duringExit = fadeUp({ frame: at + exit / 2, fps: FPS, duration: entry, exit: { at } });
  assert.ok(duringExit.opacity > 0 && duringExit.opacity < 1, 'fading out in between');
});

test('MS1: maskRise stays within the 105-118% / 3-5deg envelope', () => {
  const start = maskRise({ frame: 0, fps: FPS, delay: 0, duration: 24 });
  assert.ok(start.translateYPercent >= 105 && start.translateYPercent <= 118, `rise ${start.translateYPercent}`);
  assert.ok(start.rotate >= 3 && start.rotate <= 5, `tilt ${start.rotate}`);
  assert.equal(start.opacity, 0);
  const settled = maskRise({ frame: 24, fps: FPS, delay: 0, duration: 24 });
  assert.equal(settled.translateYPercent, 0);
  assert.equal(settled.rotate, 0);
  assert.equal(settled.opacity, 1);
  // out-of-range inputs are clamped, not obeyed
  const clamped = maskRise({ frame: 0, fps: FPS, distancePercent: 300, tilt: 45 });
  assert.equal(clamped.translateYPercent, 118);
  assert.equal(clamped.rotate, 5);
});

test('MS1: pop springs from 0 toward 1 and is deterministic', () => {
  assert.equal(pop({ frame: 0, fps: FPS, delay: 0 }).scale, 0);
  const settled = pop({ frame: 90, fps: FPS, delay: 0 }).scale;
  assert.ok(Math.abs(settled - 1) < 0.02, `pop settles near 1, got ${settled}`);
  assert.deepEqual(pop({ frame: 7, fps: FPS }), pop({ frame: 7, fps: FPS }));
});

test('MS1: countUp lands exactly on the target and rounds', () => {
  assert.equal(countUp({ frame: 0, fps: FPS, delay: 0, duration: 30, to: 1234 }).value, 0);
  assert.equal(countUp({ frame: 30, fps: FPS, delay: 0, duration: 30, to: 1234 }).value, 1234);
  assert.equal(countUp({ frame: 999, fps: FPS, to: 1234 }).value, 1234);
  const mid = countUp({ frame: 15, fps: FPS, delay: 0, duration: 30, to: 999 }).value;
  assert.ok(Number.isInteger(mid) && mid >= 0 && mid <= 999);
  const down = countUp({ frame: 999, fps: FPS, delay: 0, duration: 30, from: 100, to: 0 });
  assert.equal(down.value, 0);
});

test('MS1: enterExit caps an entry that is cut short by an overlapping exit', () => {
  const { in: enter } = enterExit(10, { delay: 0, duration: 18, exit: { at: 6, duration: 6 } });
  assert.ok(enter < 1, 'the entry is capped by the exit, not left mid-way up');
  assert.equal(enterExit(0, { delay: 0, duration: 18 }).out, 0, 'no exit means no out progress');
});

test('MS1: exitFade falls from 1 to 0 over its window', () => {
  assert.equal(exitFade(0, { at: 0, duration: 12 }), 1);
  assert.equal(exitFade(12, { at: 0, duration: 12 }), 0);
  assert.equal(exitFade(100, { at: 0, duration: 12 }), 0);
});
