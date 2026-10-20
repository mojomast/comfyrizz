import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagramState } from '../src/diagram-model.js';

test('diagram beats follow speech cues rather than firing together at the entrance', () => {
  const props = { fps: 30, sceneFrames: 600, count: 3, cues: [1, 5, 12] };
  assert.equal(diagramState({ ...props, frame: 29 }).active, -1);
  const middle = diagramState({ ...props, frame: 180 });
  assert.equal(middle.active, 1);
  assert.equal(middle.cards[0].reveal, 1);
  assert.equal(middle.cards[1].reveal, 1);
  assert.equal(middle.cards[2].reveal, 0);
  assert.equal(diagramState({ ...props, frame: 390 }).active, 2);
  assert.equal(diagramState({ ...props, frame: 599 }).progress, 1);
});

test('invalid cue lists fall back deterministically within the scene', () => {
  const props = { frame: 200, fps: 30, sceneFrames: 600, count: 3 };
  const fallback = diagramState(props);
  for (const cues of [[1], [5, 2, 1], [-1, 3, 5]]) assert.deepEqual(diagramState({ ...props, cues }), fallback);
});
