import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CASSETTE_ENV, cassetteFetch } from '../src/cassette-hook.mjs';

const FIXTURE = fileURLToPath(new URL('../../../scripts/cassette/fixtures/launch-brief.cassette.json', import.meta.url));
const CHAT_URL = 'https://provider.example.test/v1/chat/completions';

function completion(text) {
  return {
    id: 'chatcmpl-hook-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'hook-test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
  };
}

test('unset or unrecognized env returns the identical fetch object', () => {
  const fetchImpl = async () => new Response('unused');
  assert.equal(cassetteFetch({}, fetchImpl), fetchImpl);
  assert.equal(cassetteFetch({ [CASSETTE_ENV]: '' }, fetchImpl), fetchImpl);
  assert.equal(cassetteFetch({ [CASSETTE_ENV]: 'off' }, fetchImpl), fetchImpl);
});

test('play serves the recorded fixture without calling the network', async () => {
  const cassette = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const entry = cassette.entries[0];
  const fetchImpl = () => {
    throw new Error('play mode must not call the network');
  };
  const wrapped = cassetteFetch({ [CASSETTE_ENV]: `play:${FIXTURE}` }, fetchImpl);
  const response = await wrapped(CHAT_URL, {
    method: 'POST',
    body: JSON.stringify(entry.request),
  });
  assert.equal(response.status, entry.response.status);
  assert.deepEqual(await response.json(), entry.response.body);
});

test('play adapts a recorded completion to a streaming request', async () => {
  const cassette = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const entry = cassette.entries[0];
  const wrapped = cassetteFetch({ [CASSETTE_ENV]: `play:${FIXTURE}` }, async () => {
    throw new Error('play mode must not call the network');
  });
  const response = await wrapped(CHAT_URL, {
    method: 'POST',
    body: JSON.stringify({ ...entry.request, stream: true }),
  });
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /^data: /);
  assert.match(text, /data: \[DONE\]/);
});

test('record writes a valid cassette after each entry', async (t) => {
  const dir = mkdtempSync(join(process.cwd(), 'cassette-hook-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.cassette.json');

  const requests = ['first prompt', 'second prompt'];
  const fetchImpl = async (_input, init) => {
    const request = JSON.parse(init.body);
    const text = request.messages.at(-1).content;
    return new Response(JSON.stringify(completion(`answer to ${text}`)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const wrapped = cassetteFetch({ [CASSETTE_ENV]: `record:${file}` }, fetchImpl);
  for (const content of requests) {
    const response = await wrapped(CHAT_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'hook-test-model',
        messages: [{ role: 'user', content }],
      }),
    });
    assert.equal(response.status, 200);
  }

  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.schema, 'comfyrizz.cassette/v1');
  assert.equal(saved.entries.length, 2);
  assert.equal(saved.model, 'hook-test-model');
  for (const entry of saved.entries) {
    assert.match(entry.key, /^[0-9a-f]{64}$/);
    assert.equal(entry.response.status, 200);
  }
  assert.deepEqual(
    saved.entries.map(entry => entry.response.body.choices[0].message.content),
    requests.map(content => `answer to ${content}`),
  );
});

test('record refuses a path outside the runtime directory and cwd', () => {
  const outside = resolve(process.cwd(), '..', 'outside.cassette.json');
  assert.throws(
    () => cassetteFetch({ [CASSETTE_ENV]: `record:${outside}` }, async () => new Response('unused')),
    /Cassette record path/,
  );
});
