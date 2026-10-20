import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCassette } from './format.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, 'cli.mjs');
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const FAKE_KEY = ['sk', 'fakekeyforcliredact', '1234567890'].join('-');

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function messagesFor(text) {
  return [
    { role: 'system', content: 'You are a synthetic test assistant.' },
    { role: 'user', content: text },
  ];
}

function makeCassette({ model = 'test-model', provider = 'test-provider', entries } = {}) {
  return {
    schema: 'comfyrizz.cassette/v1',
    createdAt: '2026-10-20T00:00:00.000Z',
    model,
    provider,
    entries: entries || [
      {
        key: KEY_A,
        request: { model, messages: messagesFor('Plan a launch brief.'), temperature: 0.2 },
        response: {
          status: 200,
          body: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Here is the brief.',
                  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'plan_storyboard', arguments: '{"title":"Launch"}' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        },
      },
    ],
  };
}

async function writeTempJson(dir, name, value) {
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cassette-cli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('validate accepts a temporary valid cassette and reports counts', async () => {
  await withTempDir(async (dir) => {
    const file = await writeTempJson(dir, 'valid.cassette.json', makeCassette());
    const result = runCli(['validate', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^valid comfyrizz\.cassette\/v1: 1 entries/m);
    assert.doesNotMatch(result.stdout, /Here is the brief/);
  });
});

test('validate exits 1 with path-specific errors for an invalid cassette', async () => {
  await withTempDir(async (dir) => {
    const file = await writeTempJson(dir, 'invalid.cassette.json', {
      schema: 'wrong/v1',
      createdAt: 'not-a-date',
      model: '',
      provider: '',
      entries: [{ key: 'nope', request: { messages: 'no' }, response: { status: 'ok' } }],
    });
    const result = runCli(['validate', file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid cassette/);
    assert.match(result.stderr, /schema: expected/);
    assert.match(result.stderr, /entries\[0\]\.key/);
    assert.match(result.stderr, /entries\[0\]\.request\.messages/);
  });
});

test('validate exits 1 for malformed JSON', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{ not json', 'utf8');
    const result = runCli(['validate', file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid JSON/);
  });
});

test('stats reports counts without printing request bodies', async () => {
  await withTempDir(async (dir) => {
    const bodyMarker = 'STATS_MUST_NOT_PRINT_THIS_BODY';
    const cassette = makeCassette();
    cassette.entries[0].request.messages[1].content = bodyMarker;
    const file = await writeTempJson(dir, 'stats.cassette.json', cassette);
    const result = runCli(['stats', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /entries: 1/);
    assert.match(result.stdout, /unique keys: 1/);
    assert.match(result.stdout, /tool calls: 1/);
    assert.match(result.stdout, /plan_storyboard/);
    assert.doesNotMatch(result.stdout, new RegExp(bodyMarker));
  });
});

test('diff --md renders a model comparison table with changed tool calls', async () => {
  await withTempDir(async (dir) => {
    const a = makeCassette({ model: 'model-alpha', provider: 'provider-a' });
    const b = makeCassette({ model: 'model-beta', provider: 'provider-b' });
    b.entries[0].response.body.choices[0].message.tool_calls[0].function.name = 'script_scene';
    b.entries[0].response.body.choices[0].message.tool_calls[0].function.arguments = '{"scene":1}';
    b.entries[0].response.body.choices[0].message.content = 'Here is the script.';
    const fileA = await writeTempJson(dir, 'a.cassette.json', a);
    const fileB = await writeTempJson(dir, 'b.cassette.json', b);

    const result = runCli(['diff', fileA, fileB, '--md']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# Cassette diff: model-alpha vs model-beta/m);
    assert.match(result.stdout, /\| turn \| text changed \| tool calls \|/);
    assert.match(result.stdout, /1 changed turn\(s\)/);
    assert.match(result.stdout, /model-alpha: plan_storyboard\(title\)/);
    assert.match(result.stdout, /model-beta: script_scene\(scene\)/);
    assert.doesNotMatch(result.stdout, /Here is the brief\.\n/);
  });
});

test('diff without --md is a plain summary', async () => {
  await withTempDir(async (dir) => {
    const a = makeCassette();
    const b = makeCassette();
    const fileA = await writeTempJson(dir, 'same-a.cassette.json', a);
    const fileB = await writeTempJson(dir, 'same-b.cassette.json', b);
    const result = runCli(['diff', fileA, fileB]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /identical: 1/);
    assert.match(result.stdout, /changed: 0/);
    assert.doesNotMatch(result.stdout, /^# Cassette diff/m);
  });
});

test('redact writes a valid cassette with the fake key removed', async () => {
  await withTempDir(async (dir) => {
    const cassette = makeCassette();
    cassette.entries[0].request.headers = { authorization: `Bearer ${FAKE_KEY}` };
    cassette.entries[0].request.messages[1].content = `Use ${FAKE_KEY} to prepare the launch brief.`;
    cassette.entries[0].response.body.choices[0].message.content = `Token ${FAKE_KEY} was used.`;
    cassette.entries.push({
      key: KEY_B,
      request: { model: 'test-model', messages: messagesFor('Follow up.') },
      response: { status: 200, body: { choices: [{ message: { role: 'assistant', content: `saw ${FAKE_KEY}` } }] } },
    });
    const input = await writeTempJson(dir, 'secret.cassette.json', cassette);
    const output = join(dir, 'redacted.cassette.json');

    const result = runCli(['redact', input, output]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(FAKE_KEY));
    assert.match(result.stdout, /redacted 2 entries/);

    const raw = await readFile(output, 'utf8');
    assert.doesNotMatch(raw, new RegExp(FAKE_KEY));
    const parsed = JSON.parse(raw);
    assert.equal(validateCassette(parsed).ok, true);
    assert.equal(parsed.entries[0].request.headers, undefined);
    assert.match(raw, /\[REDACTED\]/);

    const validation = runCli(['validate', output]);
    assert.equal(validation.status, 0, validation.stderr);
  });
});

test('unknown commands and missing arguments exit 1', () => {
  const unknown = runCli(['frobnicate']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command/);
  const missing = runCli(['validate']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /expects exactly one file/);
});

test('diff --md previews stay within 80 characters', async () => {
  await withTempDir(async (dir) => {
    const longText = `${'brief '.repeat(40)}tail`;
    const a = makeCassette();
    const b = makeCassette();
    a.entries[0].request.messages[1].content = longText;
    b.entries[0].request.messages[1].content = longText;
    a.entries[0].response.body.choices[0].message.content = 'one';
    b.entries[0].response.body.choices[0].message.content = 'two';
    const fileA = await writeTempJson(dir, 'long-a.cassette.json', a);
    const fileB = await writeTempJson(dir, 'long-b.cassette.json', b);
    const result = runCli(['diff', fileA, fileB, '--md']);
    assert.equal(result.status, 0, result.stderr);
    const row = result.stdout.split('\n').find((line) => line.startsWith('| brief'));
    assert.ok(row);
    const preview = row.split('|')[1].trim();
    assert.ok(preview.length <= 80, `preview is ${preview.length} characters`);
  });
});
