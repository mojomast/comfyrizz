import assert from 'node:assert/strict';
import test from 'node:test';
import { PRESETS, resolveProvider } from '../src/presets.js';
import { createOpenAICompatibleModel, listModels } from '../src/openai-compatible.js';
import { probeToolUse } from '../src/probe.js';
import type { ChatChunk, ChatMessage, ToolDef } from '../src/types.js';

const tool: ToolDef = {
  name: 'ping',
  description: 'ping',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
};

function sse(events: unknown[]): Response {
  const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function config(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return {
    name: 'custom',
    baseUrl: 'http://mock/v1',
    modelsUrl: 'http://mock/v1/models',
    apiKey: 'test-key',
    model: 'test-model',
    headers: { 'x-test': 'yes' },
    status: 'baseline' as const,
    fetchImpl,
    maxRetries: 0,
    ...overrides,
  };
}

const request = { system: 'sys', messages: [{ role: 'user' as const, content: 'hello' }], tools: [tool], signal: new AbortController().signal, sessionId: 's1' };

async function collect(model: ReturnType<typeof createOpenAICompatibleModel>, req = request): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of model.stream(req)) chunks.push(chunk);
  return chunks;
}

test('presets: three providers, OpenCode fallback key and session header', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ['custom', 'opencode-go', 'openrouter']);
  const oc = resolveProvider('opencode-go', { env: { OPENCODE_GO_API_KEY: 'k' } });
  assert.equal(oc.apiKey, 'k');
  assert.equal(oc.sessionHeader, 'x-opencode-session');
  assert.equal(oc.headers['User-Agent'], 'comfyrizz/0.1');
  assert.equal(oc.model, 'deepseek-v4.1-flash');
  const custom = resolveProvider('custom', { env: {} });
  assert.equal(custom.apiKey, null);
  assert.throws(() => resolveProvider('openrouter', { env: {} }), /requires OPENROUTER_API_KEY/);
  assert.throws(() => resolveProvider('openrouter', { env: { OPENROUTER_API_KEY: 'secret' }, apiKey: null }), /requires/);
});

test('streams text and usage, sends bearer + session header and keeps tools out when empty', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init ?? {} };
    return sse([
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
    ]);
  }) as typeof fetch;
  const chunks = await collect(createOpenAICompatibleModel(config(fetchImpl, { sessionHeader: 'x-opencode-session' })));
  assert.deepEqual(chunks, [
    { type: 'text', delta: 'Hel' },
    { type: 'text', delta: 'lo' },
    { type: 'usage', input: 7, output: 2 },
    { type: 'done' },
  ]);
  assert.equal(seen?.url, 'http://mock/v1/chat/completions');
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer test-key');
  assert.equal(headers['x-test'], 'yes');
  assert.equal(headers['x-opencode-session'], 's1');
  const body = JSON.parse(String(seen?.init.body));
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, true);
  assert.equal(body.tools.length, 1);
  const noTools = await collect(createOpenAICompatibleModel(config(fetchImpl)), { ...request, tools: [] });
  assert.equal(JSON.parse(String(seen?.init.body)).tools, undefined);
  assert.ok(noTools.some(chunk => chunk.type === 'done'));
});

test('assembles fragmented tool arguments and emits only a complete call', async () => {
  const fetchImpl = (async () => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'pi' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ng', arguments: '{"val' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ue":"po' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ng"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
  ])) as typeof fetch;
  const chunks = await collect(createOpenAICompatibleModel(config(fetchImpl)));
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'tool_call'), [
    { type: 'tool_call', id: 'call_1', name: 'ping', args: { value: 'pong' } },
  ]);
  assert.ok(chunks.some(chunk => chunk.type === 'usage' && chunk.input === 5));
});

test('maps dotted app tool names to the provider-safe pattern and back', async () => {
  const dotted: ToolDef = { ...tool, name: 'storyboard.propose' };
  const fetchImpl = (async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'storyboard_propose', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }])) as typeof fetch;
  const chunks = await collect(createOpenAICompatibleModel(config(fetchImpl)), { ...request, tools: [dotted] });
  const call = chunks.find(chunk => chunk.type === 'tool_call');
  assert.equal(call?.type, 'tool_call');
  assert.equal((call as { name?: string }).name, 'storyboard.propose');
});

test('malformed tool JSON is an error, not an executed call', async () => {
  const fetchImpl = (async () => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'ping', arguments: '{"value":' } }] }, finish_reason: 'tool_calls' }] },
  ])) as typeof fetch;
  const chunks = await collect(createOpenAICompatibleModel(config(fetchImpl)));
  assert.equal(chunks.filter(chunk => chunk.type === 'tool_call').length, 0);
  const error = chunks.find(chunk => chunk.type === 'error');
  assert.equal(error?.code, 'invalid_tool_arguments');
  assert.equal((error as { toolCallId?: string }).toolCallId, 'call_bad');
});

test('retries 429 with Retry-After, then streams', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    return sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
  }) as typeof fetch;
  const chunks = await collect(createOpenAICompatibleModel(config(fetchImpl, { maxRetries: 1 })));
  assert.equal(calls, 2);
  assert.ok(chunks.some(chunk => chunk.type === 'text' && chunk.delta === 'ok'));
});

test('provider HTTP errors are structured and do not include the key', async () => {
  const fetchImpl = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
  const chunks = await collect(createOpenAICompatibleModel(config(fetchImpl, { apiKey: 'super-secret' })));
  const error = chunks.find(chunk => chunk.type === 'error');
  assert.equal(error?.code, 'http_401');
  assert.ok(!(error?.message ?? '').includes('super-secret'));
});

test('listModels accepts OpenAI and bare-array shapes', async () => {
  const openai = (async () => new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await listModels(config(openai)), ['a', 'b']);
  const bare = (async () => new Response(JSON.stringify([{ id: 'c' }]), { status: 200 })) as typeof fetch;
  assert.deepEqual(await listModels(config(bare)), ['c']);
});

test('probe: tool call then follow-up; refuses a text-only model', async () => {
  let chat = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: 200 });
    chat += 1;
    if (chat === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'comfyrizz_probe_ping', arguments: '{"value":"pong"}' } }] }, finish_reason: 'tool_calls' }] }]);
    return sse([{ choices: [{ delta: { content: 'pong received' }, finish_reason: 'stop' }] }]);
  }) as typeof fetch;
  const result = await probeToolUse(config(fetchImpl));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.models, 1);
  assert.deepEqual(result.toolCall?.args, { value: 'pong' });
  assert.equal(result.followUp, 'pong received');

  const noTool = (async () => sse([{ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }])) as typeof fetch;
  const refused = await probeToolUse(config(noTool));
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /no tool call/);
});
