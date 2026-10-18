// MS1: motion tokens and pure timing helpers. The acceptance checks from the board:
// every easing token maps 0->0 and 1->1, `land` overshoots by <= 12%, exits are 50-75% of
// entries, stagger total is capped, and the same frame always gives the same output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EXIT_RATIO,
  EASING_TOKENS,
  ENERGY_PROFILES,
  MAX_EXIT_RATIO,
  MAX_STAGGER_SECONDS,
  MIN_EXIT_RATIO,
  SPRING_PRESETS,
  STAGGER_SECONDS,
  clamp,
  cubicBezier,
  ease,
  energyProfile,
  exitDuration,
  prog,
  seededRandom,
  springValue,
  staggerFrames,
  staggerWithinCap,
} from '../src/motion/index.js';

test('MS1: every easing token maps 0 -> 0 and 1 -> 1', () => {
  for (const [name, points] of Object.entries(EASING_TOKENS)) {
    assert.equal(points.length, 4, `${name} is a cubic bezier`);
    assert.equal(ease(name, 0), 0, `${name}(0) is 0`);
    assert.equal(ease(name, 1), 1, `${name}(1) is 1`);
    assert.equal(cubicBezier(...points)(0), 0);
    assert.equal(cubicBezier(...points)(1), 1);
  }
});

test('MS1: ease tokens are monotone in x and stay finite across the range', () => {
  for (const name of Object.keys(EASING_TOKENS)) {
    let previous = -Infinity;
    for (let i = 0; i <= 200; i += 1) {
      const y = ease(name, i / 200);
      assert.ok(Number.isFinite(y), `${name}(${i / 200}) is finite`);
      // `land` deliberately overshoots, so the curve may rise above 1; it must never dip below 0.
      assert.ok(y >= -1e-9, `${name}(${i / 200}) >= 0`);
      previous = y;
    }
    assert.ok(previous > 0.99, `${name} ends at 1`);
  }
});

test('MS1: land overshoots by at most 12%', () => {
  let max = -Infinity;
  for (let i = 0; i <= 1000; i += 1) max = Math.max(max, ease('land', i / 1000));
  assert.ok(max > 1, 'land actually overshoots');
  assert.ok(max - 1 <= 0.12, `land overshoot ${(max - 1).toFixed(4)} <= 0.12`);
});

test('MS1: prog() clamps and agrees with the ease token', () => {
  assert.equal(prog(0, 0, 18, 'enter'), 0);
  assert.equal(prog(-5, 0, 18, 'enter'), 0);
  assert.equal(prog(18, 0, 18, 'enter'), 1);
  assert.equal(prog(99, 0, 18, 'enter'), 1);
  assert.equal(prog(9, 0, 18, 'linear'), 0.5);
  assert.ok(Math.abs(prog(9, 0, 18, 'enter') - ease('enter', 0.5)) < 1e-9);
  // a zero-length window is a step, not a division by zero
  assert.equal(prog(0, 4, 0, 'enter'), 0);
  assert.equal(prog(4, 4, 0, 'enter'), 1);
});

test('MS1: exit duration is 50-75% of the entry, ratio clamped', () => {
  for (const entry of [12, 18, 24, 30, 40]) {
    const exit = exitDuration(entry);
    assert.ok(exit >= entry * MIN_EXIT_RATIO - 1e-9, `${exit} >= 50% of ${entry}`);
    assert.ok(exit <= entry * MAX_EXIT_RATIO + 1e-9, `${exit} <= 75% of ${entry}`);
  }
  assert.equal(exitDuration(20, 0.1), 20 * MIN_EXIT_RATIO, 'a too-small ratio is clamped up');
  assert.equal(exitDuration(20, 0.95), 20 * MAX_EXIT_RATIO, 'a too-large ratio is clamped down');
  assert.equal(exitDuration(20), 20 * DEFAULT_EXIT_RATIO);
  assert.ok(exitDuration(0) >= 1, 'never a zero-frame exit');
});

test('MS1: stagger is capped at 0.5 s total', () => {
  const fps = 30;
  const cap = MAX_STAGGER_SECONDS * fps;
  assert.equal(staggerFrames(0, STAGGER_SECONDS.word, fps), 0);
  assert.ok(Math.abs(staggerFrames(1, STAGGER_SECONDS.word, fps) - STAGGER_SECONDS.word * fps) < 1e-9);
  for (let i = 0; i < 50; i += 1) {
    assert.ok(staggerFrames(i, STAGGER_SECONDS.listItem, fps) <= cap, `item ${i} delay <= cap`);
  }
  assert.equal(staggerFrames(49, STAGGER_SECONDS.listItem, fps), cap, 'a long list sits exactly at the cap');
  assert.equal(staggerFrames(-3, STAGGER_SECONDS.word, fps), 0, 'a negative index is 0');
  assert.equal(staggerFrames(3, STAGGER_SECONDS.dot, fps, 0.2), Math.min(3 * STAGGER_SECONDS.dot * fps, 0.2 * fps));
});

test('MS1: staggerWithinCap tightens when items overflow the cap', () => {
  const fps = 30;
  assert.equal(staggerWithinCap(3, STAGGER_SECONDS.word, fps), 3, 'a short list is untouched');
  const many = staggerWithinCap(20, STAGGER_SECONDS.listItem, fps);
  assert.ok(many < 20, 'a long list is tightened');
  assert.ok(staggerFrames(many - 1, STAGGER_SECONDS.listItem, fps) <= MAX_STAGGER_SECONDS * fps);
});

test('MS1: energy profiles exist and medium is the default', () => {
  assert.deepEqual(energyProfile('nope'), ENERGY_PROFILES.medium);
  assert.deepEqual(energyProfile(), ENERGY_PROFILES.medium);
  assert.ok(ENERGY_PROFILES.high.entryScale < ENERGY_PROFILES.calm.entryScale, 'high is quicker than calm');
  assert.ok(ENERGY_PROFILES.high.staggerScale < ENERGY_PROFILES.calm.staggerScale);
});

test('MS1: springs start at 0 and are deterministic', () => {
  for (const preset of Object.keys(SPRING_PRESETS)) {
    assert.equal(springValue(0, preset), 0, `${preset} starts at 0`);
    assert.equal(springValue(-1, preset), 0, `${preset} stays at 0 before the start`);
    assert.equal(springValue(1, preset), springValue(1, preset), `${preset} is deterministic`);
    assert.ok(springValue(1, preset) > 0.99, `${preset} has essentially settled after 1 s`);
  }
  assert.notEqual(springValue(0.1, 'pop'), springValue(0.1, 'heavy'), 'presets differ');
});

test('MS1: the same frame gives the same output twice (determinism)', () => {
  const sample = (frame) => [
    ease('enter', frame / 30),
    ease('land', frame / 30),
    prog(frame, 4, 20, 'enter'),
    staggerFrames(frame, STAGGER_SECONDS.word, 30),
    exitDuration(frame + 1),
    springValue(frame / 30, 'settle'),
  ];
  for (let frame = 0; frame <= 40; frame += 1) {
    assert.deepEqual(sample(frame), sample(frame), `frame ${frame} is stable`);
  }
});

test('MS1: seeded randomness is deterministic and reproducible', () => {
  const a = seededRandom(17);
  const b = seededRandom(17);
  const c = seededRandom(18);
  const valuesA = Array.from({ length: 12 }, () => a());
  const valuesB = Array.from({ length: 12 }, () => b());
  assert.deepEqual(valuesA, valuesB, 'same seed, same sequence');
  assert.notDeepEqual(valuesA, Array.from({ length: 12 }, () => c()), 'different seed, different sequence');
  assert.ok(valuesA.every((value) => value >= 0 && value <= 1));
});

test('MS1: clamp keeps values in range', () => {
  assert.equal(clamp(0.5), 0.5);
  assert.equal(clamp(-1), 0);
  assert.equal(clamp(2), 1);
  assert.equal(clamp(5, 0, 10), 5);
});
