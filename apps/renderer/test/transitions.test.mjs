import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSITION_TYPES,
  DIRECTION_AXIS,
  ENERGY_TRANSITION_SECONDS,
  BLUR_MAX_PX,
  energyTransitionSeconds,
  energyTransitionFrames,
  resolvedDirection,
  transitionProgress,
  pushOffset,
  zoomScales,
  irisRadius,
  blurAmount,
  fadeOpacity,
  transitionStyle,
} from '../src/motion/transitions.js';
import { ease } from '../src/motion/index.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('the transition vocabulary matches the MS2 schema types', () => {
  assert.deepEqual(TRANSITION_TYPES, ['none', 'cut', 'fade', 'blur', 'slide', 'push', 'wipe', 'zoom', 'iris']);
});

test('energy picks a duration inside the research range', () => {
  for (const energy of ['calm', 'medium', 'high']) {
    const [lo, hi] = ENERGY_TRANSITION_SECONDS[energy];
    for (const position of [0, 0.25, 0.5, 0.75, 1]) {
      const seconds = energyTransitionSeconds(energy, position);
      assert.ok(seconds >= lo - 1e-9 && seconds <= hi + 1e-9, `${energy}@${position}=${seconds}`);
    }
    assert.equal(energyTransitionSeconds(energy, 0), lo);
    assert.equal(energyTransitionSeconds(energy, 1), hi);
    assert.ok(energyTransitionFrames(energy, 30, 0.5) >= 1);
  }
  // an unknown energy falls back to medium, never NaN.
  assert.equal(energyTransitionSeconds('turbo', 0), ENERGY_TRANSITION_SECONDS.medium[0]);
});

test('directional types fall back to the package current, scale types to in', () => {
  assert.equal(resolvedDirection('push', undefined, 'right'), 'right');
  assert.equal(resolvedDirection('push', undefined, 'nonsense'), 'left');
  assert.equal(resolvedDirection('push', 'up', 'right'), 'up');
  assert.equal(resolvedDirection('slide', 'down'), 'down');
  assert.equal(resolvedDirection('zoom', 'out'), 'out');
  assert.equal(resolvedDirection('zoom', undefined), 'in');
  assert.equal(resolvedDirection('iris', 'left'), 'in');
  assert.equal(resolvedDirection('fade', 'left'), null);
});

test('push moves both scenes the same distance with mirrored easing', () => {
  const start = pushOffset(0, 'left');
  const end = pushOffset(1, 'left');
  assert.deepEqual(start.outgoing, { x: 0, y: 0 });
  assert.deepEqual(start.entering, { x: 1, y: 0 });
  assert.deepEqual(end.outgoing, { x: -1, y: 0 });
  assert.deepEqual(end.entering, { x: 0, y: 0 });
  for (const p of [0.2, 0.5, 0.8]) {
    assert.ok(near(pushOffset(p, 'left').outgoing.x, -ease('exit', p)));
    assert.ok(near(pushOffset(p, 'left').entering.x, 1 - ease('enter', p)));
  }
  // right is the mirror of left; down uses the y axis.
  assert.deepEqual(pushOffset(0.5, 'right').outgoing, { x: -pushOffset(0.5, 'left').outgoing.x, y: 0 });
  assert.equal(pushOffset(0.5, 'down').axis, 'y');
  assert.equal(DIRECTION_AXIS.up.axis, 'y');
});

test('zoom keeps d(scale)/dt the same sign on both sides', () => {
  const step = 1e-3;
  const inOut = zoomScales(0.5, 'in');
  const inOutPrev = zoomScales(0.5 - step, 'in');
  assert.ok(inOut.outgoing - inOutPrev.outgoing > 0); // outgoing grows
  assert.ok(inOut.entering - inOutPrev.entering > 0); // entering grows too
  assert.ok(near(zoomScales(1, 'in').entering, 1));
  assert.ok(zoomScales(1, 'in').outgoing > 1);
  const outNow = zoomScales(0.5, 'out');
  const outPrev = zoomScales(0.5 - step, 'out');
  assert.ok(outNow.outgoing - outPrev.outgoing < 0); // both shrink
  assert.ok(outNow.entering - outPrev.entering < 0);
});

test('iris radius covers all four corners for 16:9 and 9:16', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
    const radius = irisRadius(width, height);
    const farthest = Math.max(
      Math.hypot(width / 2, height / 2),
      Math.hypot(width / 2, height / 2),
    );
    assert.ok(radius >= farthest, `${width}x${height} radius ${radius} < ${farthest}`);
    assert.ok(near(radius, farthest * 1.05, 1e-6));
    // an off-centre focal point still covers the farthest corner.
    const off = irisRadius(width, height, { focal: { x: 0.2, y: 0.3 } });
    const corners = [[0, 0], [width, 0], [0, height], [width, height]];
    const need = Math.max(...corners.map(([x, y]) => Math.hypot(x - 0.2 * width, y - 0.3 * height)));
    assert.ok(off >= need);
  }
});

test('blur peaks mid-transition and fade crossfades', () => {
  assert.equal(blurAmount(0), 0);
  assert.ok(near(blurAmount(0.5), BLUR_MAX_PX));
  assert.ok(blurAmount(1) < 1e-9);
  assert.deepEqual(fadeOpacity(0), { outgoing: 1, entering: 0 });
  assert.deepEqual(fadeOpacity(1), { outgoing: 0, entering: 1 });
});

test('transitionStyle maps the maths to frame-sized styles', () => {
  const cut = transitionStyle('cut', 0.5);
  assert.equal(cut.kind, 'cut');
  assert.deepEqual(cut.outgoing, {});
  const push = transitionStyle('push', 0, { direction: 'left', width: 1920, height: 1080, packageDirection: 'right' });
  assert.equal(push.direction, 'left');
  assert.equal(push.entering.transform, 'translate(1920px, 0px)');
  const slide = transitionStyle('slide', 0, { direction: 'left' });
  assert.equal(slide.outgoing.transform, 'translate(0px, 0px)');
  const wipe = transitionStyle('wipe', 0.25, { direction: 'left' });
  assert.equal(wipe.kind, 'wipe');
  assert.equal(wipe.entering.clipPath, 'inset(0 0 0 75%)');
  assert.equal(transitionStyle('wipe', 0.25, { direction: 'right' }).entering.clipPath, 'inset(0 75% 0 0)');
  assert.equal(transitionStyle('wipe', 0.25, { direction: 'up' }).entering.clipPath, 'inset(75% 0 0 0)');
  assert.equal(transitionStyle('wipe', 0.25, { direction: 'down' }).entering.clipPath, 'inset(0 0 75% 0)');
  const iris = transitionStyle('iris', 0.5, { width: 1920, height: 1080 });
  assert.ok(iris.radius > 0 && iris.radius < irisRadius(1920, 1080));
  assert.match(iris.entering.clipPath, /^circle\(/);
  assert.equal(transitionStyle('blur', 0.5).outgoing.filter, `blur(${BLUR_MAX_PX}px)`);
  assert.equal(transitionProgress(5, 10), 0.5);
  assert.equal(transitionProgress(0, 0), 1);
});
