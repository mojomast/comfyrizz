import test from 'node:test';
import assert from 'node:assert/strict';
import { runPiRuntime, toPiMessages, fromPiMessages } from '../src/pi-runtime.js';
import type { ChatMessage, ChatModel, ChatRequest } from '../src/types.js';

test('Pi owns serialized tool turns and wire preserves complete schemas, reasoning and current tool changes', async () => {
  const requests: ChatRequest[] = [], lifecycle: string[] = [], executed: string[] = [];
  const messages: ChatMessage[] = [{ role: 'user', content: 'Build then inspect' }];
  const definition = { name: 'project.write', description: 'Full authoritative description', parameters: { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'string', enum: ['source_42'] } }, additionalProperties: false } };
  let current = 0;
  const model: ChatModel = { id: 'deepseek-configured', async *stream(request) {
    requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ChatRequest);
    if (requests.length === 1) {
      yield { type: 'reasoning', delta: 'private provider continuation' };
      yield { type: 'tool_call', id: 'operation_1', name: definition.name, args: { sourceId: 'source_42' } };
      yield { type: 'usage', input: 20, output: 5, cacheRead: 7 };
    } else yield { type: 'text', delta: 'Done' };
  } };
  await runPiRuntime({ model, signal: new AbortController().signal, sessionId: 'stable-session',
    prepare: step => { current = step; return { system: `policy ${step}`, messages, tools: step === 1 ? [definition] : [] }; },
    onChunk: () => {}, afterModel: () => {
      if (current > 1) return 'stop';
      messages.push({ role: 'assistant', reasoning_content: 'private provider continuation', tool_calls: [{ id: 'operation_1', name: definition.name, args: { sourceId: 'source_42' } }] });
      return 'tools';
    }, execute: async call => {
      executed.push(call.id); messages.push({ role: 'tool', tool_call_id: call.id, content: '{"revision":2}' });
      return { content: '{"revision":2}' };
    }, onPiEvent: event => lifecycle.push(event.type),
  });
  assert.deepEqual(requests[0].tools, [definition]);
  assert.deepEqual(requests[1].tools, []);
  assert.equal(requests[1].system, 'policy 2');
  assert.equal(requests[1].sessionId, 'stable-session');
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'Build then inspect' }, { role: 'assistant', content: '', reasoning_content: 'private provider continuation', tool_calls: [{ id: 'operation_1', name: definition.name, args: { sourceId: 'source_42' } }] }, { role: 'tool', tool_call_id: 'operation_1', content: '{"revision":2}' }]);
  assert.deepEqual(executed, ['operation_1']);
  assert.ok(lifecycle.indexOf('tool_execution_start') < lifecycle.indexOf('tool_execution_end'));
  assert.equal(lifecycle.filter(e => e === 'turn_start').length, 2);
});

test('Pi cancellation settles a blocked model read without running tools', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const model: ChatModel = { id: 'blocked', stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => { entered(); return new Promise(() => {}); } }) }) };
  const running = runPiRuntime({ model, signal: controller.signal, sessionId: 'cancel',
    prepare: () => ({ system: '', messages: [{ role: 'user', content: 'go' }], tools: [] }),
    onChunk: () => {}, afterModel: () => 'tools', execute: async () => { assert.fail('No cancelled tool may run'); },
  });
  await reading; controller.abort(new Error('deadline'));
  await assert.rejects(running, /deadline/);
});

test('checkpoint transcript round-trip preserves multimodal paths and tool identities', () => {
  const model = { id: 'vision' } as ChatModel;
  const messages: ChatMessage[] = [{ role: 'user', content: 'inspect', images: [{ path: '/safe/contact.png', mediaType: 'image/png' }] }, { role: 'assistant', content: '', reasoning_content: 'continuation', tool_calls: [{ id: 'stable', name: 'read', args: { id: 'source' } }] }, { role: 'tool', tool_call_id: 'stable', content: '{"ok":true}' }];
  assert.deepEqual(fromPiMessages(JSON.parse(JSON.stringify(toPiMessages(messages, model)))), messages);
});

test('a throwing tool callback propagates its failure and suppresses later sibling mutations', async () => {
  const invoked: string[] = [];
  const failure = new Error('dispatch journal unavailable');
  const model: ChatModel = { id: 'callback-failure', async *stream() {
    yield { type: 'tool_call', id: 'first', name: 'write', args: {} };
    yield { type: 'tool_call', id: 'second', name: 'write', args: {} };
  } };
  await assert.rejects(runPiRuntime({ model, signal: new AbortController().signal, sessionId: 'callback-failure',
    prepare: () => ({ system: '', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'write', description: 'Mutation', parameters: { type: 'object' } }] }),
    onChunk: () => {}, afterModel: () => 'tools',
    execute: async call => { invoked.push(call.id); throw failure; },
  }), error => error === failure);
  assert.deepEqual(invoked, ['first']);
});
