import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { runAgent } from '../src/agent.js';
import { extendDrawingToolSchema } from '../src/procedural-drawing.js';
import type { ChatChunk, ChatModel, ChatRequest } from '../src/types.js';

function scripted(turns: ChatChunk[][]) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = { id: 'recovery-regression', async *stream(request) {
    requests.push({ ...request, messages: [...request.messages] });
    const turn = turns[requests.length - 1];
    assert.ok(turn, 'unexpected extra model request');
    yield* turn;
  } };
  return { model, requests };
}

test('distinct schema errors get actionable feedback and only corrected arguments execute', async () => {
  const { model, requests } = scripted([
    [{ type: 'tool_call', id: 'a', name: 'save', args: { scene: 1, duration: 5 } }],
    [{ type: 'tool_call', id: 'b', name: 'save', args: { scene: 'one', duration: 0 } }],
    [{ type: 'tool_call', id: 'c', name: 'save', args: { scene: 'one', duration: 5, palette: 3 } }],
    [{ type: 'tool_call', id: 'd', name: 'save', args: { scene: 'one', duration: 5, palette: 'ink' } }],
    [{ type: 'text', delta: 'Saved.' }],
  ]);
  const executed: unknown[] = [];
  const result = await runAgent({ model, brief: 'save', maxSteps: 5, maxRepairs: 3, tools: {
    save: { definition: { name: 'save', description: '', parameters: {} },
      schema: z.object({ scene: z.string(), duration: z.number().positive(), palette: z.string().optional() }),
      run(args) { executed.push(args); return { saved: true }; } },
  } });
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 'final');
  assert.deepEqual(executed, [{ scene: 'one', duration: 5, palette: 'ink' }]);
  for (const [index, path] of ['scene', 'duration', 'palette'].entries()) {
    const feedback = requests[index + 1].messages.find(m => m.role === 'tool' && m.tool_call_id === ['a', 'b', 'c'][index]);
    assert.ok(feedback && feedback.role === 'tool');
    const parsed = JSON.parse(feedback.content);
    assert.equal(parsed.error, 'invalid_arguments');
    assert.equal(parsed.repair, index + 1);
    assert.ok(parsed.issues.some((issue: { path: string }) => issue.path === path));
  }
});

test('invalid retries obey the overall step cap even when repair budget remains', async () => {
  const { model, requests } = scripted([
    [{ type: 'tool_call', id: 'a', name: 'save', args: { value: 1 } }],
    [{ type: 'tool_call', id: 'b', name: 'save', args: { value: 2 } }],
  ]);
  let executions = 0;
  const result = await runAgent({ model, brief: 'save', maxSteps: 2, maxInvalidArgumentRepairs: 10, tools: {
    save: { definition: { name: 'save', description: '', parameters: {} }, schema: z.object({ value: z.string() }),
      run() { executions++; return {}; } },
  } });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, 'max_steps');
  assert.equal(requests.length, 2);
  assert.equal(executions, 0);
});

test('reordered identical invalid arguments receive one warning then stop', async () => {
  const { model, requests } = scripted([
    [{ type: 'tool_call', id: 'a', name: 'save', args: { first: 1, second: 2 } }],
    [{ type: 'tool_call', id: 'b', name: 'save', args: { second: 2, first: 1 } }],
    [{ type: 'tool_call', id: 'c', name: 'save', args: { first: 1, second: 2 } }],
  ]);
  const result = await runAgent({ model, brief: 'save', maxSteps: 10, maxInvalidArgumentRepairs: 10, tools: {
    save: { definition: { name: 'save', description: '', parameters: {} }, schema: z.object({ first: z.string(), second: z.string() }),
      run() { assert.fail('invalid arguments must never execute'); } },
  } });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, 'repair_limit');
  assert.equal(result.toolCalls.at(-1)?.error, 'duplicate_invalid_call');
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[2].messages), /identical to a previous invalid call/);
});

test('a duplicate warning allows a corrected discriminator to execute', async () => {
  const element = { text: 'label', x: 3, y: 4, color: '#000000', size: 20, start: 0, end: 5 };
  const { model, requests } = scripted([
    [{ type: 'tool_call', id: 'a', name: 'draw', args: { scene_id: 's5', elements: [element] } }],
    [{ type: 'tool_call', id: 'b', name: 'draw', args: { scene_id: 's5', elements: [element] } }],
    [{ type: 'tool_call', id: 'c', name: 'draw', args: { scene_id: 's5', elements: [{ ...element, type: 'text' }] } }],
    [{ type: 'text', delta: 'done' }],
  ]);
  let executions = 0;
  const result = await runAgent({ model, brief: 'draw', maxSteps: 5, maxInvalidArgumentRepairs: 4, tools: {
    draw: { definition: { name: 'draw', description: '', parameters: {} }, schema: extendDrawingToolSchema,
      run() { executions++; return {}; } },
  } });
  assert.equal(result.ok, true);
  assert.equal(executions, 1);
  assert.match(JSON.stringify(requests[2].messages), /duplicate_invalid_call/);
  assert.match(JSON.stringify(requests[2].messages), /elements.0.type/);
});

test('successful work on another scene does not clear an unresolved invalid scene', async () => {
  const { model } = scripted([
    [{ type: 'tool_call', id: 'bad', name: 'save', args: { scene_id: 's1' } }, { type: 'tool_call', id: 'good', name: 'save', args: { scene_id: 's2', value: 'ok' } }],
    [{ type: 'text', delta: 'Done.' }],
  ]);
  const result = await runAgent({ model, brief: 'save', tools: {
    save: { definition: { name: 'save', description: '', parameters: {} }, schema: z.object({ scene_id: z.string(), value: z.string() }), run() { return {}; } },
  } });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /scene s1/);
});

test('a final message cannot turn an unresolved invalid call into success', async () => {
  const { model } = scripted([
    [{ type: 'tool_call', id: 'a', name: 'save', args: {} }],
    [{ type: 'text', delta: 'Done.' }],
  ]);
  const result = await runAgent({ model, brief: 'save', tools: {
    save: { definition: { name: 'save', description: '', parameters: {} }, schema: z.object({ value: z.string() }), run() { assert.fail(); } },
  } });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'unresolved_invalid_arguments');
});

test('higher schema allowance does not increase the malformed-turn allowance or replay side effects', async () => {
  const { model, requests } = scripted([
    [{ type: 'tool_call', id: 'saved', name: 'save', args: { value: 'completed' } }],
    [{ type: 'tool_call', id: 'discarded', name: 'save', args: { value: 'discarded' } }, { type: 'error', code: 'invalid_tool_arguments' }],
    [{ type: 'tool_call', id: 'again', name: 'save', args: { value: 'completed' } }, { type: 'error', code: 'invalid_tool_arguments' }],
    [{ type: 'tool_call', id: 'never', name: 'save', args: { value: 'never' } }, { type: 'error', code: 'invalid_tool_arguments' }],
  ]);
  const executed: string[] = [];
  const result = await runAgent({ model, brief: 'save', maxSteps: 10, maxInvalidArgumentRepairs: 6, tools: {
    save: { definition: { name: 'save', description: '', parameters: {} }, schema: z.object({ value: z.string() }),
      run(args) { executed.push(args.value); return {}; } },
  } });
  assert.equal(result.stopped, 'repair_limit');
  assert.equal(result.errorCode, 'invalid_tool_arguments');
  assert.equal(requests.length, 4);
  assert.deepEqual(executed, ['completed']);
});

test('the default shared repair limit remains unchanged', async () => {
  const { model, requests } = scripted([1, 2, 3].map(value => [{ type: 'tool_call', id: String(value), name: 'save', args: { value } }]));
  const result = await runAgent({ model, brief: 'save', tools: {
    save: { definition: { name: 'save', description: '', parameters: {} }, schema: z.object({ value: z.string() }),
      run() { assert.fail('invalid arguments must never execute'); } },
  } });
  assert.equal(result.stopped, 'repair_limit');
  assert.equal(requests.length, 3);
});
