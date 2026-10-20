import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, CassetteMiss } from './player.mjs';
import { requestKey } from './format.mjs';

const baseCassette = {
  schema: 'comfyrizz.cassette/v1',
  createdAt: new Date().toISOString(),
  model: 'test-model',
  provider: 'test-provider',
  entries: [],
};

const makeEntry = (overrides = {}) => {
  const defaultRequest = {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Make a 20s product intro.' },
    ],
    tools: [],
    tool_choice: 'auto',
    temperature: 0.2,
  };
  const request = { ...defaultRequest, ...overrides.request };
  const key = overrides.key || requestKey(request);
  return { key, request, response: overrides.response || { status: 200, body: { ok: true, response: 'recorded' } } };
};

const cassetteWithOneEntry = {
  ...baseCassette,
  entries: [makeEntry()],
};

const cassetteWithThreeEntries = {
  ...baseCassette,
  entries: [
    makeEntry({ key: 'a'.repeat(64) }),
    makeEntry({ key: 'b'.repeat(64) }),
    makeEntry({ key: 'c'.repeat(64) }),
  ],
};

const cassetteWithDifferentEntries = {
  ...baseCassette,
  entries: [
    makeEntry({
      key: '0'.repeat(64),
      request: {
        model: 'm',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Make a 20s product intro.' },
        ],
      },
      response: { status: 200, body: { ok: true } },
    }),
    makeEntry({
      key: '1'.repeat(64),
      request: {
        model: 'm',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Plan a launch video.' },
        ],
      },
      response: { status: 200, body: { ok: true } },
    }),
  ],
};

test('strict hit returns recorded body', async () => {
  const player = createPlayer(cassetteWithOneEntry, { mode: 'strict' });
  const request = {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Make a 20s product intro.' },
    ],
    tools: [],
    tool_choice: 'auto',
    temperature: 0.2,
  };
  const response = await player(request);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text, JSON.stringify({ ok: true, response: 'recorded' }));
});

test('strict miss error lists previews', async () => {
  const player = createPlayer(cassetteWithOneEntry, { mode: 'strict' });
  const request = {
    model: 'different-model',
    messages: [
      { role: 'system', content: 'You are a different assistant.' },
      { role: 'user', content: ' entirely different request' },
    ],
    tools: [],
    tool_choice: 'auto',
    temperature: 0.2,
  };
  let threw = false;
  let missError;
  try {
    await player(request);
  } catch (err) {
    threw = true;
    missError = err;
  }
  assert.ok(threw, 'Should have thrown');
  assert.ok(missError instanceof CassetteMiss);
  assert.ok(Array.isArray(missError.closestPreviews));
});

test('strict miss with 3 closest keys when multiple entries exist', async () => {
  const player = createPlayer(cassetteWithThreeEntries, { mode: 'strict' });
  const request = {
    model: 'different-model',
    messages: [
      { role: 'system', content: 'You are a different assistant.' },
      { role: 'user', content: 'completely different' },
    ],
    tools: [],
    tool_choice: 'auto',
    temperature: 0.2,
  };
  let threw = false;
  let missError;
  try {
    await player(request);
  } catch (err) {
    threw = true;
    missError = err;
  }
  assert.ok(threw, 'Should have thrown');
  assert.ok(missError instanceof CassetteMiss);
  assert.ok(Array.isArray(missError.closestPreviews));
  assert.ok(missError.closestPreviews.length <= 3);
  for (const preview of missError.closestPreviews) {
    assert.ok(typeof preview.key === 'string');
    assert.ok(typeof preview.preview === 'string');
  }
});

test('sequential order serves entries in order', async () => {
  const player = createPlayer(cassetteWithThreeEntries, { mode: 'sequential' });
  const r1 = await player({ model: 'm', messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'hi' }
  ], tools: [], tool_choice: 'auto', temperature: 0.2 });
  const r2 = await player({ model: 'm', messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'hi 2' }
  ], tools: [], tool_choice: 'auto', temperature: 0.2 });
  const r3 = await player({ model: 'm', messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'hi 3' }
  ], tools: [], tool_choice: 'auto', temperature: 0.2 });

  const t1 = await r1.text();
  const t2 = await r2.text();
  const t3 = await r3.text();

  assert.equal(t1, JSON.stringify({ ok: true, response: 'recorded' }));
  assert.equal(t2, JSON.stringify({ ok: true, response: 'recorded' }));
  assert.equal(t3, JSON.stringify({ ok: true, response: 'recorded' }));
});

test('sequential exhaustion throws error', async () => {
  const player = createPlayer(cassetteWithOneEntry, { mode: 'sequential' });
  const r1 = await player({ model: 'm', messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'hi' }
  ], tools: [], tool_choice: 'auto', temperature: 0.2 });
  const text1 = await r1.text();
  assert.ok(text1.includes('ok'));

  let threw = false;
  try {
    await player({ model: 'm', messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi2' }
    ], tools: [], tool_choice: 'auto', temperature: 0.2 });
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes('exhausted') || err.message.includes('entries'));
  }
  assert.ok(threw, 'Should have thrown on exhaustion');
});

test('stats counts served and misses', async () => {
  const player = createPlayer(cassetteWithOneEntry, { mode: 'strict' });
  assert.ok(typeof player.stats === 'function');

  const request = {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Make a 20s product intro.' },
    ],
    tools: [],
    tool_choice: 'auto',
    temperature: 0.2,
  };
  await player(request);
  const s = player.stats();
  assert.equal(s.served, 1);
  assert.equal(s.misses, 0);
});

test('stats after miss with empty cassette', async () => {
  const player = createPlayer(baseCassette, { mode: 'strict' });
  assert.ok(typeof player.stats === 'function');

  const request = {
    model: 'different-model',
    messages: [
      { role: 'system', content: 'You are a different assistant.' },
      { role: 'user', content: 'entirely different' }
    ],
    tools: [],
    tool_choice: 'auto',
    temperature: 0.2,
  };
  try {
    await player(request);
  } catch (err) {
    // expected miss
  }
  const s = player.stats();
  assert.equal(s.served, 0);
  assert.equal(s.misses, 1);
});