import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { createToolset } from '../src/tools.js';
import type { ChatModel, ChatRequest } from '../src/types.js';

test('propose and edits retain normalized editorial state but do not replay CSV wall geometry', async () => {
  const csv = ['category', ...Array.from({ length: 190 }, (_, i) => i === 189 ? 'win' : 'start')].join('\n');
  let latest: any;
  const tools = createToolset({ csvAttachments: [{ id: 'csv', label: 'source.csv', text: csv, contentHash: 'a'.repeat(64) }], onPackageChange: pkg => { latest = pkg; } });
  const calls = [
    { id: 'p', name: 'storyboard.propose', args: { brief: 'Data story', title: 'Story', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 120 }] } },
    { id: 'wall', name: 'storyboard.csv_tile_wall', args: { scene_id: 's1', id: 'csv', filters: [], category_column: 'category', colors: [{ value: 'win', color: '#ff0000' }], default_color: '#222222', background: '#000000', columns: 20 } },
    { id: 'e', name: 'storyboard.edit', args: { scene_id: 's1', patch: { preferredFrames: 150 } } },
    { id: 'inspect', name: 'storyboard.inspect_drawing', args: { scene_id: 's1' } },
  ];
  const requests: ChatRequest[] = [];
  const model: ChatModel = { id: 'script', async *stream(request) {
    requests.push(structuredClone(request));
    const call = calls[requests.length - 1];
    if (call) yield { type: 'tool_call', ...call };
    else yield { type: 'text', delta: 'Done' };
  } };
  const result = await runAgent({ model, brief: 'Data story', tools, maxSteps: 5 });
  assert.equal(result.ok, true);
  const message = requests[3].messages.find(m => m.role === 'tool' && m.tool_call_id === 'e');
  assert.equal(message?.role, 'tool');
  if (message?.role !== 'tool') throw new Error('missing edit response');
  const compact = JSON.parse(message.content);
  const full = result.toolCalls.find(call => call.id === 'e')!.result as any;
  assert.equal(compact.revision, full.revision);
  assert.equal(compact.package.scenes[0].preferredFrames, 150);
  assert.equal(compact.package.scenes[0].drawing_summary.elements, 190);
  assert.equal(compact.package.scenes[0].drawing_summary.source.sha256, 'a'.repeat(64));
  assert.equal(full.package.scenes[0].drawing.elements.length, 190);
  assert.ok(message.content.length < JSON.stringify(full).length / 5);
  const inspection = result.toolCalls.find(call => call.id === 'inspect')!.result as any;
  assert.deepEqual(inspection.drawing, latest.scenes[0].drawing);
  assert.deepEqual(compact.motion_fixes, full.motion_fixes);
});
