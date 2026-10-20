import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCassette } from '../format.mjs';

const FIXTURE_MAX_BYTES = 30 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'launch-brief.cassette.json');
const toolsPath = join(here, '..', '..', '..', 'packages', 'agent', 'src', 'tools.ts');

function loadFixture() {
  const raw = readFileSync(fixturePath, 'utf8');
  return { raw, cassette: JSON.parse(raw) };
}

function toolNamesFromSource(source) {
  const names = new Set();
  for (const match of source.matchAll(/['"]([A-Za-z][A-Za-z0-9_.-]*)['"]\s*:\s*tool\(/g)) names.add(match[1]);
  for (const match of source.matchAll(/tool\(\s*['"]([^'"]+)['"]/g)) names.add(match[1]);
  return [...names].sort();
}

function toolNamesInCassette(cassette) {
  const names = new Set();
  for (const entry of cassette.entries ?? []) {
    for (const tool of entry?.request?.tools ?? []) {
      const name = tool?.function?.name;
      if (typeof name === 'string') names.add(name);
    }
    const body = entry?.response?.body;
    const message = body?.choices?.[0]?.message;
    for (const call of message?.tool_calls ?? []) {
      const name = call?.function?.name;
      if (typeof name === 'string') names.add(name);
    }
  }
  return [...names].sort();
}

test('fixture passes validateCassette', () => {
  const { cassette } = loadFixture();
  const result = validateCassette(cassette);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('fixture has 3-5 entries and stays under 30 KB', () => {
  const { raw, cassette } = loadFixture();
  assert.ok(cassette.entries.length >= 3 && cassette.entries.length <= 5);
  const bytes = Buffer.byteLength(raw, 'utf8');
  assert.ok(bytes < FIXTURE_MAX_BYTES, `fixture is ${bytes} bytes, limit is ${FIXTURE_MAX_BYTES}`);
});

test('every tool name used exists in packages/agent/src/tools.ts', () => {
  const source = readFileSync(toolsPath, 'utf8');
  const exposed = new Set(toolNamesFromSource(source));
  assert.ok(exposed.size > 0, 'no tool names found in packages/agent/src/tools.ts');

  const used = toolNamesInCassette(loadFixture().cassette);
  assert.ok(used.length > 0, 'fixture uses no tool names');
  const missing = used.filter((name) => !exposed.has(name));
  assert.deepEqual(missing, [], `tool names missing from tools.ts: ${missing.join(', ')}`);
});

test('fixture uses real agent tool names', () => {
  const used = toolNamesInCassette(loadFixture().cassette);
  for (const name of ['storyboard.propose', 'assets.route', 'assets.generate_image', 'presenter.set']) {
    assert.ok(used.includes(name), `expected the fixture to use ${name}`);
  }
});

test('assistant tool calls parse and every turn has a finish_reason', () => {
  const { cassette } = loadFixture();
  for (const [index, entry] of cassette.entries.entries()) {
    const choice = entry.response.body.choices[0];
    assert.ok(choice, `entry ${index} has a choice`);
    assert.equal(typeof choice.finish_reason, 'string');
    assert.ok(choice.finish_reason.length > 0, `entry ${index} finish_reason is empty`);
    for (const call of choice.message.tool_calls ?? []) {
      assert.equal(call.type, 'function');
      assert.ok(typeof call.function.name === 'string' && call.function.name.length > 0);
      assert.doesNotThrow(() => JSON.parse(call.function.arguments), `entry ${index} tool arguments are not JSON`);
    }
  }
});

test('fixture text is synthetic and holds no secrets or absolute paths', () => {
  const { raw } = loadFixture();
  assert.ok(!/\bsk-[A-Za-z0-9_-]{6,}\b/.test(raw), 'fixture contains an sk- key');
  assert.ok(!/\bhf_[A-Za-z0-9]{6,}\b/.test(raw), 'fixture contains an hf_ token');
  assert.ok(!/\bghp_[A-Za-z0-9]{6,}\b/.test(raw), 'fixture contains a ghp_ token');
  assert.ok(!/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(raw), 'fixture contains a bearer credential');
  assert.ok(!/["'`\s]\/(?:home|Users|workspace)\b/.test(raw), 'fixture contains an absolute user path');
  assert.ok(raw.includes('fictional') || raw.includes('synthetic'), 'fixture text should be clearly synthetic');
});
