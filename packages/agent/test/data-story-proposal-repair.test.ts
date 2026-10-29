import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { createToolset } from '../src/tools.js';
import type { ChatChunk, ChatModel, ChatRequest } from '../src/types.js';

test('recorded CSV provenance and missing-stat failures return actionable feedback and preserve sourced data', async () => {
  const scenes = [{ id: 's6', layout: 'stat', preferredFrames: 168, copy: { headline: 'Starts' }, data: { dataset: 'd_starts', display: 'number' } }];
  const dataset = { unit: 'starts', values: [{ label: 'Starts through Sakhir', value: 190 }], source: 'perez-starts-through-sakhir.csv — grouped rows' };
  const base = { brief: 'Tell the supplied data story', title: 'Starts', scenes, datasets: { d_starts: dataset } };
  const fixed = { ...base, datasets: { d_starts: { ...dataset, source: 'derived', note: dataset.source } } };
  const missing = { ...fixed, scenes: [{ ...scenes[0], data: undefined }] };
  const turns: ChatChunk[][] = [
    [{ type: 'tool_call', id: 'source', name: 'storyboard.propose', args: base }],
    [{ type: 'tool_call', id: 'stat', name: 'storyboard.propose', args: missing }],
    [{ type: 'tool_call', id: 'corrected', name: 'storyboard.propose', args: fixed }],
    [{ type: 'text', delta: 'Draft ready.' }],
  ];
  const requests: ChatRequest[] = [];
  const model: ChatModel = { id: 'recorded-proposal', async *stream(request) { requests.push({ ...request, messages: [...request.messages] }); yield* turns[requests.length - 1]; } };
  const tools = createToolset({});
  const result = await runAgent({ model, brief: 'Use the supplied CSV', tools, maxSteps: 4 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.toolCalls.map(call => call.ok), [false, false, true]);
  const feedback = (request: number, id: string) => JSON.parse((requests[request].messages.find(message => message.role === 'tool' && message.tool_call_id === id) as { content: string }).content);
  assert.equal(feedback(1, 'source').code, 'DATASET_SOURCE_INVALID');
  assert.match(feedback(1, 'source').instruction, /filename and derivation in note/);
  assert.equal(feedback(2, 'stat').code, 'SCENE_DATA_REQUIRED');
  assert.match(feedback(2, 'stat').instruction, /Do not remove the dataset/);
  const pkg = (result.toolCalls[2].result as any).package;
  assert.deepEqual(pkg.datasets.d_starts.values, dataset.values);
  assert.equal(pkg.datasets.d_starts.source, 'derived');
  assert.equal(pkg.scenes[0].data.dataset, 'd_starts');
});
