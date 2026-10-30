import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolset } from '../src/tools.js';

test('drawing tool validates data, commits a revision, and survives later edits', async () => {
  const tools = createToolset({ now: () => '2026-01-01T00:00:00.000Z' });
  const proposal = await tools['storyboard.propose'].run({ brief: 'A drawn staircase', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }] }) as any;
  const drawing = { background: '#ffffff', elements: [
    { type: 'path', points: [[50, 900], [300, 900], [300, 700]], color: '#111111', width: 5, start: 0, end: 60, marker: true },
    { type: 'text', x: 100, y: 200, text: 'Step', color: '#111111', size: 40, start: 60, end: 70 },
  ] };
  const args = tools['storyboard.draw'].schema.parse({ scene_id: 's1', drawing });
  const result = await tools['storyboard.draw'].run(args) as any;
  assert.equal(result.revision, proposal.revision + 1);
  assert.deepEqual(result.package.scenes[0].drawing, drawing);
  const edited = await tools['storyboard.edit'].run({ scene_id: 's1', patch: { copy: { headline: 'Stairs' } } }) as any;
  assert.deepEqual(edited.package.scenes[0].drawing, drawing);
  assert.equal(edited.revision, result.revision + 1);
  assert.equal(tools['storyboard.draw'].schema.safeParse({ scene_id: 's1', drawing: { ...drawing, elements: [{ ...drawing.elements[0], end: -1 }] } }).success, false);
  assert.equal(tools['storyboard.draw'].schema.safeParse({ scene_id: 's1', drawing: { ...drawing, elements: [{ ...drawing.elements[0], start: 80, end: 10 }] } }).success, false);
  assert.equal(tools['storyboard.draw'].schema.safeParse({ scene_id: 's1', drawing: { ...drawing, elements: [{ ...drawing.elements[0], points: [[0, 0], [1001, 0]] }] } }).success, false);
  assert.throws(() => tools['storyboard.draw'].run({ scene_id: 'missing', drawing }), /not found/);
});

test('filled planes and translucent construction strokes round-trip through the drawing tool', async () => {
  const tools = createToolset();
  await tools['storyboard.propose'].run({ brief: 'Draw a shaded block', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }] });
  const drawing = { background: '#f4f0e6', elements: [
    { type: 'polygon', points: [[100, 200], [400, 200], [350, 300], [50, 300]], color: '#cccccc', opacity: 0.7, start: 0, end: 20 },
    { type: 'path', points: [[50, 300], [350, 300]], width: 2, color: '#333333', opacity: 0.3, start: 0, end: 10 },
  ] };
  const args = tools['storyboard.draw'].schema.parse({ scene_id: 's1', drawing });
  const result = await tools['storyboard.draw'].run(args) as any;
  assert.deepEqual(result.package.scenes[0].drawing, drawing);
  const invalid = structuredClone(drawing);
  invalid.elements[0].points = [[0, 0], [1, 1]];
  assert.equal(tools['storyboard.draw'].schema.safeParse({ scene_id: 's1', drawing: invalid }).success, false);
  invalid.elements[0].points.push([2, 2]);
  invalid.elements[0].opacity = 1.1;
  assert.equal(tools['storyboard.draw'].schema.safeParse({ scene_id: 's1', drawing: invalid }).success, false);
});
