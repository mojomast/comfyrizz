import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecorder } from './recorder.mjs';
import { requestKey, validateCassette } from './format.mjs';

const FAKE_KEY = ['sk', 'fakerecorderkey0123456789'].join('-');

const CHAT_URL = 'https://provider.example.test/v1/chat/completions';
const MODELS_URL = 'https://provider.example.test/v1/models';

function chatRequest(content, extra = {}) {
  return {
    model: 'demo-model',
    messages: [
      { role: 'system', content: 'You are a launch-video agent.' },
      { role: 'user', content },
    ],
    ...extra,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chatCompletion(text, toolCalls) {
  return {
    id: 'chatcmpl-test-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'demo-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text ?? null,
          ...(toolCalls
            ? {
                tool_calls: toolCalls.map((call, index) => ({
                  id: `call_${index}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                })),
              }
            : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
  };
}

function fakeUpstream(handler) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    return handler(input, init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('two chat calls record two entries with the correct request keys', async () => {
  const upstream = fakeUpstream((_input, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse(chatCompletion(`reply to ${body.messages.at(-1).content}`));
  });
  const recorder = createRecorder({
    fetch: upstream,
    meta: { model: 'demo-model', provider: 'fake-provider', createdAt: '2026-10-20T00:00:00.000Z' },
  });

  const first = chatRequest('first prompt');
  const second = chatRequest('second prompt');
  const firstResponse = await recorder.fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(first),
  });
  const secondResponse = await recorder.fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(second),
  });

  assert.equal(firstResponse.status, 200);
  assert.equal((await firstResponse.json()).choices[0].message.content, 'reply to first prompt');
  assert.equal((await secondResponse.json()).choices[0].message.content, 'reply to second prompt');

  const { entries } = recorder.cassette();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].key, requestKey(first));
  assert.equal(entries[1].key, requestKey(second));
  assert.notEqual(entries[0].key, entries[1].key);
  assert.deepEqual(entries[0].request, first);
  assert.equal(entries[0].response.status, 200);
  assert.equal(entries[0].response.body.choices[0].message.content, 'reply to first prompt');
  assert.equal(upstream.calls.length, 2);
  assert.equal(upstream.calls[0].input, CHAT_URL);
  assert.equal(upstream.calls[0].init.body, JSON.stringify(first));
});

test('non-chat URLs pass through and are not recorded', async () => {
  const upstream = fakeUpstream(() => jsonResponse({ data: [{ id: 'demo-model' }] }));
  const recorder = createRecorder({ fetch: upstream, meta: { model: 'demo-model', provider: 'fake-provider' } });

  const response = await recorder.fetch(MODELS_URL, { method: 'GET' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ id: 'demo-model' }] });
  assert.deepEqual(recorder.cassette().entries, []);

  const chatGet = await recorder.fetch(CHAT_URL, { method: 'GET' });
  assert.equal(chatGet.status, 200);
  assert.deepEqual(recorder.cassette().entries, []);
  assert.equal(upstream.calls.length, 2);
});

test('saved cassette validates and contains no fake key', async () => {
  const upstream = fakeUpstream(() => jsonResponse(chatCompletion(`ack ${FAKE_KEY}`)));
  const recorder = createRecorder({
    fetch: upstream,
    meta: { model: 'demo-model', provider: 'fake-provider', createdAt: '2026-10-20T00:00:00.000Z' },
  });
  await recorder.fetch(CHAT_URL, {
    method: 'POST',
    body: JSON.stringify(chatRequest(`use ${FAKE_KEY} for this run`)),
  });

  const dir = await mkdtemp(join(tmpdir(), 'comfyrizz-recorder-'));
  const file = join(dir, 'session.cassette.json');
  try {
    const saved = await recorder.save(file, { writeFile });
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes(FAKE_KEY), 'saved cassette must not contain the fake key');
    assert.ok(!JSON.stringify(saved).includes(FAKE_KEY));
    const parsed = JSON.parse(text);
    const result = validateCassette(parsed);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(parsed.schema, 'comfyrizz.cassette/v1');
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].request.headers, undefined);
    assert.ok(text.includes('[REDACTED]'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upstream errors are recorded and rethrown', async () => {
  const boom = Object.assign(new Error('upstream exploded'), { status: 503 });
  const recorder = createRecorder({
    fetch: async () => {
      throw boom;
    },
    meta: { model: 'demo-model', provider: 'fake-provider' },
  });
  const request = chatRequest('error prompt');

  await assert.rejects(
    recorder.fetch(CHAT_URL, { method: 'POST', body: JSON.stringify(request) }),
    (error) => error === boom,
  );

  const { entries } = recorder.cassette();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, requestKey(request));
  assert.equal(entries[0].response.status, 503);
  assert.equal(entries[0].response.body.error.message, 'upstream exploded');
  assert.equal(entries[0].response.message, 'upstream exploded');
});

test('non-ok responses are recorded without changing fetch semantics', async () => {
  const recorder = createRecorder({
    fetch: async () => jsonResponse({ error: { message: 'rate limited' } }, 429),
    meta: { model: 'demo-model', provider: 'fake-provider' },
  });
  const response = await recorder.fetch(CHAT_URL, {
    method: 'POST',
    body: JSON.stringify(chatRequest('slow down')),
  });
  assert.equal(response.status, 429);
  const { entries } = recorder.cassette();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].response.status, 429);
  assert.equal(entries[0].response.body.error.message, 'rate limited');
});

test('streaming responses record the assembled final body and note stream', async () => {
  const chunks = [
    { id: 'chatcmpl-stream', created: 1700000001, model: 'demo-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
    { id: 'chatcmpl-stream', created: 1700000001, model: 'demo-model', choices: [{ index: 0, delta: { content: 'lo', tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'plan_storyboard', arguments: '{"sc' } }] } }] },
    { id: 'chatcmpl-stream', created: 1700000001, model: 'demo-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'enes":2}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  const recorder = createRecorder({
    fetch: async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    meta: { model: 'demo-model', provider: 'fake-provider' },
  });

  const request = chatRequest('stream please', { stream: true, stream_options: { include_usage: true } });
  const response = await recorder.fetch(CHAT_URL, { method: 'POST', body: JSON.stringify(request) });
  const delivered = await response.text();
  assert.equal(delivered, sse);

  const { entries } = recorder.cassette();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, requestKey(request));
  assert.equal(entries[0].response.stream, true);
  const message = entries[0].response.body.choices[0].message;
  assert.equal(message.content, 'Hello');
  assert.equal(message.tool_calls[0].function.name, 'plan_storyboard');
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { scenes: 2 });
  assert.equal(entries[0].response.body.choices[0].finish_reason, 'tool_calls');
});

test('save defaults a missing model and provider so the cassette validates', async () => {
  const recorder = createRecorder({ fetch: async () => jsonResponse(chatCompletion('ok')) });
  const request = chatRequest('hello');
  await recorder.fetch(CHAT_URL, { method: 'POST', body: JSON.stringify(request) });

  const dir = await mkdtemp(join(tmpdir(), 'comfyrizz-recorder-'));
  const file = join(dir, 'defaults.cassette.json');
  try {
    await recorder.save(file, { writeFileSync });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.model, 'demo-model');
    assert.equal(saved.provider, 'unknown');
    assert.equal(validateCassette(saved).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a recorder requires a fetch implementation', () => {
  assert.throws(() => createRecorder({}), /requires a fetch function/);
});
