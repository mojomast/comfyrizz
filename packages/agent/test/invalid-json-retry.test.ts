import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { runAgent } from '../src/agent.js';
import type { ChatChunk, ChatModel, ChatRequest } from '../src/types.js';

test('malformed turn is discarded and repair continues after completed side effects', async () => {
  const executed: string[] = [];
  const requests: ChatRequest[] = [];
  const turns: ChatChunk[][] = [
    [{ type: 'tool_call', id: 'a', name: 'write', args: { value: 'first' } }],
    [{ type: 'tool_call', id: 'b', name: 'write', args: { value: 'unexecuted' } }, { type: 'error', code: 'invalid_tool_arguments', message: 'tool write arguments are not complete JSON' }],
    [{ type: 'tool_call', id: 'repeat', name: 'write', args: { value: 'first' } }, { type: 'tool_call', id: 'c', name: 'write', args: { value: 'corrected' } }],
    [{ type: 'text', delta: 'done' }],
  ];
  const model: ChatModel = { id: 'test', async *stream(request) { requests.push({ ...request, messages: [...request.messages] }); yield* turns[requests.length - 1]; } };
  const result = await runAgent({ model, brief: 'go', tools: { write: {
    definition: { name: 'write', description: '', parameters: {} }, schema: z.object({ value: z.string() }),
    run(args) { executed.push(args.value); return { saved: args.value }; },
  } } });
  assert.equal(result.ok, true);
  assert.deepEqual(executed, ['first', 'corrected']);
  assert.equal(requests[2].messages.filter(m => m.role === 'tool').length, 1);
  assert.match(JSON.stringify(requests[2].messages), /No tool calls from that turn were executed/);
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /unexecuted/);
  const reused = requests[3].messages.find(message => message.role === 'tool' && message.tool_call_id === 'repeat');
  assert.equal(reused?.content, '{"saved":"first"}');
});

test('repair is bounded and truncated or damaged streams are not retried', async () => {
  for (const code of ['invalid_tool_arguments', 'incomplete_tool_calls', 'finish_length', 'bad_stream_json']) {
    let calls = 0;
    const model: ChatModel = { id: 'test', async *stream() { calls++; yield { type: 'error', code }; } };
    const result = await runAgent({ model, brief: 'go', tools: {}, maxRepairs: 1 });
    assert.equal(calls, code === 'invalid_tool_arguments' ? 2 : 1);
    assert.equal(result.stopped, code === 'invalid_tool_arguments' ? 'repair_limit' : 'model_error');
  }
});

test('a final message after a discarded malformed turn is not a successful repair', async () => {
  let turn = 0;
  const model: ChatModel = { id: 'test', async *stream() {
    if (turn++ === 0) yield { type: 'error', code: 'invalid_tool_arguments', message: 'invalid JSON' };
    else yield { type: 'text', delta: 'Done.' };
  } };
  const result = await runAgent({ model, brief: 'go', tools: {} });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'unresolved_invalid_arguments');
});
