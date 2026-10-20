import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sceneStartFrame } from '../src/demo/preview-frames.mjs';

const launchTimeline = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../examples/launch-demo/timeline.json', import.meta.url)), 'utf8'),
);

test('sceneStartFrame matches every launch-demo scene start', () => {
  for (const scene of launchTimeline.scenes) {
    assert.equal(sceneStartFrame(launchTimeline, scene.id), scene.from, scene.id);
  }
  assert.equal(sceneStartFrame(launchTimeline, 's_title'), 0);
  assert.equal(sceneStartFrame(launchTimeline, 's_chart'), 530);
  assert.equal(sceneStartFrame(launchTimeline, 's_outro'), 950);
});

test('unknown scene returns 0 without throwing', () => {
  assert.equal(sceneStartFrame(launchTimeline, 's_missing'), 0);
  assert.equal(sceneStartFrame(launchTimeline, ''), 0);
  assert.equal(sceneStartFrame(launchTimeline, undefined), 0);
  assert.equal(sceneStartFrame(null, 's_title'), 0);
  assert.equal(sceneStartFrame(undefined, 's_title'), 0);
  assert.equal(sceneStartFrame({}, 's_title'), 0);
  assert.equal(sceneStartFrame({ scenes: null }, 's_title'), 0);
  assert.equal(sceneStartFrame({ scenes: [{ id: 's_bad' }] }, 's_bad'), 0);
  assert.equal(sceneStartFrame({ scenes: [{ id: 's_bad', from: Number.NaN }] }, 's_bad'), 0);
});

test('sceneStartFrame normalizes fractional frame values', () => {
  assert.equal(sceneStartFrame({ scenes: [{ id: 's_a', from: 12.9 }] }, 's_a'), 12);
});
