import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { createToolset } from '../src/tools.js';
import { extendDrawing } from '../src/procedural-drawing.js';
import type { ChatModel } from '../src/types.js';

const line = { type: 'path', points: [[100, 100], [300, 100]], color: '#111111', width: 3, start: 0, end: 20, marker: true };
const face = { type: 'polygon', points: [[100, 100], [300, 100], [250, 200]], color: '#cccccc', start: 0, end: 10 };
const note = { type: 'text', x: 100, y: 300, text: 'Detail', color: '#111111', size: 30, start: 30, end: 40 };

test('drawing continuation retains the source identity and original derivation', () => {
  const source = { id: 'ctx_a', sha256: 'a'.repeat(64), description: '{"filters":[]}' };
  const scene = { preferredFrames: 100, drawing: { background: '#ffffff', elements: [face], source } };
  assert.deepEqual(extendDrawing({ scene_id: 's1', elements: [note] } as any, scene).source, source);
  assert.deepEqual(extendDrawing({ scene_id: 's2', source_scene_id: 's1' }, scene).source, source);
});

test('staged tool turns preserve geometry and allow an animated path removal across scenes', async () => {
  let latest: any;
  const tools = createToolset({ onPackageChange: pkg => { latest = pkg; } });
  await tools['storyboard.propose'].run({ brief: 'draw a diagram', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }, { id: 's2', layout: 'hero', preferredFrames: 100 }] });
  const calls = [
    { id: 'a', name: 'storyboard.draw', args: { scene_id: 's1', drawing: { background: '#ffffff', elements: [face, line] } } },
    { id: 'b', name: 'storyboard.extend_drawing', args: { scene_id: 's1', elements: [note] } },
    { id: 'c', name: 'storyboard.extend_drawing', args: { scene_id: 's2', source_scene_id: 's1', erase: [{ index: 1, start: 20, end: 50 }], elements: [{ ...note, text: 'Revised' }] } },
  ];
  let step = 0;
  const model: ChatModel = { id: 'staged', async *stream(request) {
    if (step > 0) {
      const toolMessage = request.messages.find(m => m.role === 'tool' && m.tool_call_id === calls[step - 1].id);
      assert.equal(toolMessage?.role, 'tool');
      if (toolMessage?.role === 'tool') assert.deepEqual(Object.keys(JSON.parse(toolMessage.content)).sort(), ['ok', 'revision', 'scene_id']);
    }
    if (step < calls.length) yield { type: 'tool_call', ...calls[step++] };
    else yield { type: 'text', delta: 'Done' };
  } };
  const result = await runAgent({ model, tools, brief: 'draw two scenes', maxSteps: 4 });
  assert.equal(result.ok, true);
  assert.deepEqual(latest.scenes[0].drawing.elements, [face, line, note]);
  assert.deepEqual(latest.scenes[1].drawing.elements, [
    { ...face, start: 0, end: 0 },
    { type: 'path', points: line.points, color: line.color, width: 3, start: 20, end: 50, erase: true },
    { ...note, start: 0, end: 0 }, { ...note, text: 'Revised' },
  ]);
  assert.ok(JSON.stringify(calls[2].args).length < JSON.stringify(latest.scenes[1].drawing).length);
  assert.equal((result.toolCalls[2].result as any).package.scenes[1].drawing.elements.length, 4);
});

test('continuation rejects unsafe source states and invalid edits without mutation', async () => {
  let latest: any;
  const tools = createToolset({ onPackageChange: pkg => { latest = pkg; } });
  await tools['storyboard.propose'].run({ brief: 'draw', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }, { id: 's2', layout: 'hero', preferredFrames: 100 }] });
  await tools['storyboard.draw'].run({ scene_id: 's1', drawing: { background: '#ffffff', elements: [face, line] } });
  const snapshot = structuredClone(latest);
  for (const args of [
    { scene_id: 's2', source_scene_id: 's1', erase: [{ index: 0, start: 1, end: 5 }] },
    { scene_id: 's2', source_scene_id: 's1', remove: [9] },
    { scene_id: 's2', source_scene_id: 'missing' },
  ]) assert.throws(() => tools['storyboard.extend_drawing'].run(args));
  assert.deepEqual(latest, snapshot);
  await tools['storyboard.draw'].run({ scene_id: 's1', drawing: { background: '#ffffff', elements: [{ ...line, end: 150 }] } });
  assert.throws(() => tools['storyboard.extend_drawing'].run({ scene_id: 's2', source_scene_id: 's1' }), /still animating/);
  assert.equal(latest.scenes[1].drawing, undefined);
});

test('continuation drops erased paths, preserves source and refuses overflow atomically', async () => {
  let latest: any;
  const tools = createToolset({ onPackageChange: pkg => { latest = pkg; } });
  await tools['storyboard.propose'].run({ brief: 'draw', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }, { id: 's2', layout: 'hero', preferredFrames: 100 }] });
  const gone = { ...line, erase: true, marker: false };
  await tools['storyboard.draw'].run({ scene_id: 's1', drawing: { background: '#ffffff', elements: [face, gone] } });
  await tools['storyboard.extend_drawing'].run({ scene_id: 's2', source_scene_id: 's1' });
  assert.deepEqual(latest.scenes[1].drawing.elements, [{ ...face, start: 0, end: 0 }]);
  assert.deepEqual(latest.scenes[0].drawing.elements, [face, gone]);
  const before = structuredClone(latest);
  assert.throws(() => tools['storyboard.extend_drawing'].run({ scene_id: 's2', elements: Array.from({ length: 500 }, () => note) }));
  assert.deepEqual(latest, before);
});
