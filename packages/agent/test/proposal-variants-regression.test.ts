import assert from 'node:assert/strict';
import test from 'node:test';
import { proposeSchema, createToolset } from '../src/tools.js';
import { runAgent } from '../src/agent.js';
import type { ChatModel, ChatRequest } from '../src/types.js';

const dataset = { id: 'd_starts', unit: 'starts', values: [{ label: 'Total', value: 190 }], source: 'derived', note: 'Win on start 190.' };
const proposal = { brief: 'A data story', scenes: [{ id: 's1', layout: 'focus' }, { id: 's2', layout: 'stat', data: { dataset: 'd_starts', display: 'counter' } }], datasets: [dataset] };

test('recorded focus and dataset array shapes normalize without losing data or references', async () => {
  const parsed = proposeSchema.parse(proposal);
  assert.equal(parsed.scenes?.[0].layout, 'hero');
  assert.deepEqual(parsed.datasets, { d_starts: { unit: dataset.unit, values: dataset.values, source: dataset.source, note: dataset.note } });
  const result = await createToolset({})['storyboard.propose'].run(parsed) as any;
  assert.equal(result.package.scenes[0].layout, 'hero');
  assert.equal(result.package.scenes[1].data.dataset, 'd_starts');
  assert.deepEqual(result.package.datasets.d_starts.values, dataset.values);
  for (const layout of ['title', 'hero', 'stat', 'chart', 'list', 'split', 'compare', 'code']) {
    assert.equal(proposeSchema.parse({ brief: 'x', scenes: [{ id: 's1', layout }] }).scenes?.[0].layout, layout);
  }
});

test('ambiguous dataset arrays give specific repair paths instead of overwriting', () => {
  for (const datasets of [[dataset, dataset], [{ ...dataset, id: '' }], [null]]) {
    const result = proposeSchema.safeParse({ brief: 'x', datasets });
    assert.equal(result.success, false);
    if (!result.success) assert.match(JSON.stringify(result.error.issues), /id.*unique|Duplicate dataset id/i);
  }
  assert.equal(proposeSchema.safeParse({ brief: 'x', scenes: [{ id: 's1', layout: 'unsupported' }] }).success, false);
});

test('malformed JSON recovery is actionable and includes inclusive ordinal guidance', async () => {
  const requests: ChatRequest[] = [];
  const model: ChatModel = { id: 'replay', async *stream(request) {
    requests.push({ ...request, messages: [...request.messages] });
    if (requests.length === 1) yield { type: 'error', code: 'invalid_tool_arguments', message: 'tool storyboard_propose arguments are not complete JSON' };
    else if (requests.length === 2) yield { type: 'tool_call', id: 'p', name: 'storyboard.propose', args: proposal };
    else yield { type: 'text', delta: 'Ready.' };
  } };
  const result = await runAgent({ model, brief: 'Data story', tools: createToolset({}), maxSteps: 3 });
  assert.equal(result.ok, true);
  assert.match(requests[0].system, /N−1 earlier items/);
  assert.match(JSON.stringify(requests[1].messages), /Close every string, array and object/);
});
