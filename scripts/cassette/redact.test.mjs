import test from 'node:test';
import assert from 'node:assert/strict';

import { redactEntry, redactCassette, secretEnvNames } from './redact.mjs';

const FAKE_SK = ['sk', 'fakekeyfordredacttest123456'].join('-'); // built at runtime so secret scanners skip the fixture
const FAKE_HF = 'hf_fakerepoTokenForRedact01';
const FAKE_GHP = ['ghp', 'fakeghpforredact0123456'].join('_'); // built at runtime so secret scanners skip the fixture
const FAKE_ENV_VALUE = 'env-injected-fake-secret-99';
const ABS_PATH = '/opt/example-project/fixtures/sample.json';

function sampleEntry() {
  return {
    key: 'entry-key-1',
    request: {
      model: 'demo-model',
      headers: {
        authorization: `Bearer ${FAKE_SK}`,
        'x-api-key': FAKE_HF,
      },
      messages: [
        { role: 'system', content: 'You are a helpful agent.' },
        {
          role: 'user',
          content: `Please use key ${FAKE_SK}, repo token ${FAKE_HF}, and read config at ${ABS_PATH}.`,
        },
      ],
      temperature: 0,
    },
    response: {
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: `Done. Also saw ${FAKE_GHP} and token=Bearer ${FAKE_SK} in logs.`,
            },
          },
        ],
      }),
    },
  };
}

function collectStrings(value, into = []) {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, into);
  return into;
}

test('fake keys in message text and response body are removed', () => {
  const redacted = redactEntry(sampleEntry());
  const text = collectStrings(redacted).join('\n');
  for (const fake of [FAKE_SK, FAKE_HF, FAKE_GHP]) {
    assert.ok(!text.includes(fake), `output must not contain ${fake.slice(0, 3)}…`);
  }
  assert.ok(text.includes('[REDACTED]'));
});

test('request headers are dropped', () => {
  const redacted = redactEntry(sampleEntry());
  assert.equal(redacted.request.headers, undefined);
  assert.ok(!('headers' in redacted.request));
});

test('absolute filesystem paths are replaced with <path>', () => {
  const redacted = redactEntry(sampleEntry());
  const text = collectStrings(redacted).join('\n');
  assert.ok(!text.includes(ABS_PATH));
  assert.ok(text.includes('<path>'));
});

test('input is never mutated', () => {
  const entry = sampleEntry();
  const snapshot = structuredClone(entry);
  redactEntry(entry, { env: { DEMO_API_KEY: FAKE_ENV_VALUE } });
  assert.deepEqual(entry, snapshot);

  const cassette = {
    schema: 'comfyrizz.cassette/v1',
    createdAt: '2026-10-20T00:00:00.000Z',
    model: 'demo-model',
    provider: 'demo',
    entries: [sampleEntry()],
  };
  const cassetteSnapshot = structuredClone(cassette);
  redactCassette(cassette, { env: { DEMO_API_KEY: FAKE_ENV_VALUE } });
  assert.deepEqual(cassette, cassetteSnapshot);
});

test('env-provided secret values are stripped from text', () => {
  const entry = {
    key: 'entry-key-2',
    request: {
      model: 'demo-model',
      messages: [{ role: 'user', content: `config value was ${FAKE_ENV_VALUE} ok` }],
    },
    response: { status: 200, body: `echo ${FAKE_ENV_VALUE}` },
  };
  const redacted = redactEntry(entry, { env: { DEMO_API_KEY: FAKE_ENV_VALUE } });
  const text = collectStrings(redacted).join('\n');
  assert.ok(!text.includes(FAKE_ENV_VALUE));
  assert.ok(text.includes('[REDACTED]'));
});

test('secretEnvNames reports names only, never values', () => {
  const env = {
    OPENAI_API_KEY: FAKE_SK,
    HF_TOKEN: FAKE_HF,
    PATH: '/usr/bin',
    EMPTY_SECRET: '',
  };
  const names = secretEnvNames(env);
  assert.deepEqual(names, ['HF_TOKEN', 'OPENAI_API_KEY']);
  for (const name of names) assert.ok(!collectStrings(names).includes(env[name]));
});

test('redactCassette redacts every entry and keeps metadata', () => {
  const cassette = {
    schema: 'comfyrizz.cassette/v1',
    createdAt: '2026-10-20T00:00:00.000Z',
    model: 'demo-model',
    provider: 'demo',
    entries: [sampleEntry(), sampleEntry()],
  };
  const redacted = redactCassette(cassette);
  assert.equal(redacted.schema, cassette.schema);
  assert.equal(redacted.model, cassette.model);
  assert.equal(redacted.entries.length, 2);
  const text = collectStrings(redacted.entries).join('\n');
  for (const fake of [FAKE_SK, FAKE_HF, FAKE_GHP]) {
    assert.ok(!text.includes(fake));
  }
  assert.ok(!redacted.entries.some((entry) => 'headers' in entry.request));
});

test('response body objects are redacted recursively', () => {
  const entry = {
    key: 'entry-key-3',
    request: { model: 'demo-model', messages: [] },
    response: {
      status: 200,
      body: { error: { message: `bad key ${FAKE_SK} at /var/lib/app/state.db` } },
    },
  };
  const redacted = redactEntry(entry);
  assert.equal(typeof redacted.response.body, 'object');
  assert.ok(!redacted.response.body.error.message.includes(FAKE_SK));
  assert.ok(!redacted.response.body.error.message.includes('/var/lib/app/state.db'));
  assert.ok(redacted.response.body.error.message.includes('<path>'));
});

test('windows-style absolute paths are replaced', () => {
  const winPath = String.raw`C:\Temp\demo-project\config\settings.json`;
  const entry = {
    key: 'entry-key-4',
    request: { model: 'demo-model', messages: [{ role: 'user', content: `load ${winPath}` }] },
    response: { status: 200, body: '' },
  };
  const redacted = redactEntry(entry);
  assert.ok(!collectStrings(redacted).join('\n').includes(winPath));
  assert.ok(collectStrings(redacted).join('\n').includes('<path>'));
});
