import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CASSETTE_SCHEMA,
  canonicalRequest,
  canonicalString,
  emptyCassette,
  requestKey,
  validateCassette,
} from './format.mjs';

const baseRequest = () => ({
  model: 'model-a',
  messages: [
    { role: 'system', content: 'You are a launch-video agent.' },
    { role: 'user', content: 'Make a 20s product intro.' },
  ],
  tools: [
    {
      type: 'function',
      function: { name: 'plan_storyboard', description: 'Plan scenes', parameters: { type: 'object', properties: {} } },
    },
  ],
  tool_choice: 'auto',
  temperature: 0.2,
});

test('request key is stable under key order', () => {
  const a = {
    model: 'model-a',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    tool_choice: 'auto',
  };
  const b = {
    tool_choice: 'auto',
    tools: [],
    messages: [{ content: 'hello', role: 'user' }],
    model: 'model-a',
  };
  assert.equal(requestKey(a), requestKey(b));
  assert.match(requestKey(a), /^[0-9a-f]{64}$/);
});

test('request key is stable under nested key order', () => {
  const a = {
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }],
  };
  const b = {
    tools: [{ function: { parameters: { properties: { x: { type: 'string' } }, type: 'object' }, description: 'd', name: 't' }, type: 'function' }],
    messages: [{ content: 'hi', role: 'user' }],
    model: 'model-a',
  };
  assert.equal(requestKey(a), requestKey(b));
});

test('request key ignores trailing whitespace in message content', () => {
  const clean = { model: 'model-a', messages: [{ role: 'user', content: 'Make a video' }] };
  const padded = {
    model: 'model-a',
    messages: [{ role: 'user', content: 'Make a video   \n\t ' }],
  };
  assert.equal(requestKey(clean), requestKey(padded));
});

test('request key ignores the model', () => {
  const a = baseRequest();
  const b = { ...baseRequest(), model: 'model-b' };
  assert.equal(requestKey(a), requestKey(b));
});

test('request key ignores transport flags', () => {
  const a = { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] };
  const b = { model: 'model-a', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } };
  assert.equal(requestKey(a), requestKey(b));
});

test('request key changes when the conversation changes', () => {
  const a = baseRequest();
  const b = { ...baseRequest(), messages: [{ role: 'user', content: 'Make a 60s tour.' }] };
  assert.notEqual(requestKey(a), requestKey(b));
});

test('request key is stable under tool order', () => {
  const tools = [
    { type: 'function', function: { name: 'alpha', description: 'a', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'beta', description: 'b', parameters: { type: 'object' } } },
  ];
  const a = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools };
  const b = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [...tools].reverse() };
  assert.equal(requestKey(a), requestKey(b));
});

test('tool call arguments are normalized so equivalent JSON matches', () => {
  const a = {
    model: 'm',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{"a": 1, "b": [2]}' } }],
    }],
  };
  const b = {
    model: 'm',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{"b":[2],"a":1}' } }],
    }],
  };
  assert.equal(requestKey(a), requestKey(b));
});

test('canonical request drops the model and sorts keys', () => {
  const canonical = canonicalRequest({ model: 'm', messages: [{ role: 'user', content: ' hi ' }] });
  assert.equal(canonical.model, undefined);
  assert.equal(canonical.messages[0].content, 'hi');
  assert.equal(canonicalString(canonical), '{"messages":[{"content":"hi","role":"user"}]}');
});

test('validateCassette accepts a well formed cassette', () => {
  const request = baseRequest();
  const cassette = {
    schema: CASSETTE_SCHEMA,
    createdAt: '2026-10-20T10:00:00.000Z',
    model: 'model-a',
    provider: 'openai-compatible',
    entries: [{ key: requestKey(request), request, response: { status: 200, body: { ok: true } } }],
  };
  const result = validateCassette(cassette);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('validateCassette rejects a missing schema with a path-specific error', () => {
  const result = validateCassette({ createdAt: '2026-10-20T10:00:00.000Z', model: 'm', provider: 'p', entries: [] });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, 'schema');
  assert.match(String(result.errors[0]), /^schema: /);
});

test('validateCassette rejects a bad schema value', () => {
  const result = validateCassette({ schema: 'comfyrizz.cassette/v2', createdAt: '2026-10-20T10:00:00.000Z', model: 'm', provider: 'p', entries: [] });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].path, 'schema');
});

test('validateCassette rejects bad entries with path-specific errors', () => {
  const cassette = {
    schema: CASSETTE_SCHEMA,
    createdAt: '2026-10-20T10:00:00.000Z',
    model: 'model-a',
    provider: 'openai-compatible',
    entries: [
      { key: 'not-a-hash', request: { messages: 'nope' }, response: { body: {} } },
      { key: 'a'.repeat(64), request: { messages: [{ role: 'user', content: 'hi' }] }, response: { status: 200 } },
    ],
  };
  const result = validateCassette(cassette);
  assert.equal(result.ok, false);
  const paths = result.errors.map(e => e.path);
  assert.ok(paths.includes('entries[0].key'));
  assert.ok(paths.includes('entries[0].request.messages'));
  assert.ok(paths.includes('entries[0].response.status'));
  assert.ok(paths.includes('entries[1].response.body'));
});

test('validateCassette rejects a non-object', () => {
  const result = validateCassette('nope');
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].path, 'cassette');
});

test('validateCassette rejects missing metadata fields', () => {
  const result = validateCassette({ schema: CASSETTE_SCHEMA, entries: [] });
  const paths = result.errors.map(e => e.path);
  assert.ok(paths.includes('createdAt'));
  assert.ok(paths.includes('model'));
  assert.ok(paths.includes('provider'));
});

test('emptyCassette builds a valid empty cassette', () => {
  const cassette = emptyCassette({ model: 'model-a', provider: 'openai-compatible', createdAt: '2026-10-20T10:00:00.000Z' });
  assert.equal(cassette.schema, CASSETTE_SCHEMA);
  assert.equal(cassette.model, 'model-a');
  assert.equal(cassette.provider, 'openai-compatible');
  assert.deepEqual(cassette.entries, []);
  const result = validateCassette(cassette);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('emptyCassette defaults createdAt and tolerates missing meta', () => {
  const cassette = emptyCassette();
  assert.match(cassette.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(cassette.entries, []);
});
