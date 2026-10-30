import assert from 'node:assert/strict';
import test from 'node:test';
import { drawingProgress, pointAlong } from '../src/procedural-drawing-model.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { motionGraphicsCompletionProblems } from '../../server/src/agent-runner.mjs';
import { createToolset } from '../../../packages/agent/dist/src/tools.js';
import { plannedContribution } from '../../server/test/helpers/comfy-contribution.mjs';

test('frame progress and marker follow actual polyline distance deterministically', () => {
  const path = { start: 10, end: 20 };
  assert.equal(drawingProgress(path, 0), 0);
  assert.equal(drawingProgress(path, 15), 0.5);
  assert.equal(drawingProgress(path, 30), 1);
  assert.deepEqual(pointAlong([[0, 0], [100, 0], [100, 300]], 0.5), [100, 100]);
  assert.deepEqual(pointAlong([[0, 0], [0, 0]], 0.5), [0, 0]);
  assert.deepEqual(pointAlong([[0, 0], [100, 0]], 0.5), pointAlong([[0, 0], [100, 0]], 0.5));
});

test('drawn package passes schema and requires a visible model plan for production completion', async () => {
  const tools = createToolset({ now: () => '2026-01-01T00:00:00.000Z' });
  await tools['storyboard.propose'].run({ brief: 'Sketch staircase', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }] });
  const drawing = { background: '#ffffff', elements: [{ type: 'path', points: [[0, 0], [300, 400]], width: 4, color: '#000000', start: 0, end: 50 }] };
  const result = await tools['storyboard.draw'].run(tools['storyboard.draw'].schema.parse({ scene_id: 's1', drawing }));
  const pkg = result.package;
  assert.deepEqual(validatePackage(pkg).errors, []);
  assert.deepEqual(motionGraphicsCompletionProblems({ package: pkg, svgAssets: [], pendingGpu: [], problems: [] }).map(problem => problem.code), ['COMFY_MODEL_CONTRIBUTION_REQUIRED']);
  // Drawings replace the layout. Plan the contribution in a separate visible
  // scene; attaching a hidden asset to the drawing must not satisfy admission.
  pkg.scenes.push({ id: 's_plate', layout: 'hero', preferredFrames: 60, copy: { headline: 'Staircase reference' } });
  plannedContribution(pkg, { sceneId: 's_plate' });
  assert.deepEqual(validatePackage(pkg).errors, []);
  assert.deepEqual(motionGraphicsCompletionProblems({ package: pkg, svgAssets: [], pendingGpu: [], problems: [] }), []);
  const bad = structuredClone(pkg);
  bad.scenes[0].drawing.elements[0].end = -1;
  assert.equal(validatePackage(bad).valid, false);
  bad.scenes[0].drawing.elements[0].end = 0;
  bad.scenes[0].drawing.elements[0].start = 5;
  assert.ok(validatePackage(bad).errors.some(e => e.code === 'SEM_DRAWING_TIMING'));
});

test('package schema accepts bounded filled planes and translucent strokes', async () => {
  const tools = createToolset();
  await tools['storyboard.propose'].run({ brief: 'A shaded block', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }] });
  const drawing = { background: '#eeeeee', elements: [
    { type: 'polygon', points: [[10, 20], [300, 20], [300, 200], [10, 200]], color: '#888888', opacity: 0.5, start: 0, end: 20 },
    { type: 'path', points: [[10, 20], [300, 20]], color: '#111111', opacity: 0.2, width: 2, start: 0, end: 10 },
  ] };
  const { package: pkg } = await tools['storyboard.draw'].run(tools['storyboard.draw'].schema.parse({ scene_id: 's1', drawing }));
  assert.deepEqual(validatePackage(pkg).errors, []);
  pkg.scenes[0].drawing.elements[0].points.pop();
  pkg.scenes[0].drawing.elements[0].points.pop();
  assert.equal(validatePackage(pkg).valid, false);
});
