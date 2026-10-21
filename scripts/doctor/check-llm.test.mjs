import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHECK_ID,
  CHECK_TITLE,
  PROVIDERS,
  SCRIPTED_FALLBACK_DETAIL,
  describeProviders,
  llmEnvNames,
  runLlmCheck,
} from './check-llm.mjs';
import { describeEnv } from './redact.mjs';

// Env var NAMES as they appear in the repo code (packages/llm/src/presets.ts:
// apiKeyEnv / fallbackApiKeyEnvs). Names only - never values.
const REPO_PRESET_ENV_NAMES = {
  'opencode-go': ['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  custom: ['COMFYRIZZ_CUSTOM_API_KEY'],
};

// Fake credentials for tests. These must never appear in any check output.
const FAKE_OPENCODE_KEY = 'FAKE-comfyrizz-opencode-key-0007';
const FAKE_OPENCODE_FALLBACK = 'FAKE-comfyrizz-opencode-go-key-0008';
const FAKE_OPENROUTER_KEY = 'FAKE-comfyrizz-openrouter-key-0009';
const FAKE_CUSTOM_KEY = 'FAKE-comfyrizz-custom-key-0010';

function assertNoSecretLeak(result, ...secrets) {
  const dump = JSON.stringify(result);
  for (const secret of secrets) {
    assert.ok(!dump.includes(secret), `output must not contain the secret value: ${secret.slice(0, 8)}...`);
    // "No part of the key": no distinctive 8+ character slice either.
    for (let i = 0; i + 8 <= secret.length; i += 4) {
      const slice = secret.slice(i, i + 8);
      assert.ok(!dump.includes(slice), `output must not contain a slice of the secret: ${slice}`);
    }
  }
}

test('env names match packages/llm/src/presets.ts (cite them in the test constant)', () => {
  const byId = Object.fromEntries(PROVIDERS.map(provider => [provider.id, [...provider.envNames]]));
  assert.deepEqual(byId, REPO_PRESET_ENV_NAMES);

  const presetsSource = readFileSync(new URL('../../packages/llm/src/presets.ts', import.meta.url), 'utf8');
  for (const names of Object.values(REPO_PRESET_ENV_NAMES)) {
    for (const name of names) {
      assert.ok(presetsSource.includes(`'${name}'`), `presets.ts must mention ${name}`);
    }
  }
  assert.deepEqual(llmEnvNames().sort(), [
    'COMFYRIZZ_CUSTOM_API_KEY',
    'OPENCODE_API_KEY',
    'OPENCODE_GO_API_KEY',
    'OPENROUTER_API_KEY',
  ].sort());
});

test('labels mirror the provider-settings.mjs LABELS', () => {
  const settingsSource = readFileSync(new URL('../../apps/server/src/provider-settings.mjs', import.meta.url), 'utf8');
  assert.ok(settingsSource.includes("'opencode-go': 'OpenCode Go'"));
  assert.ok(settingsSource.includes('openrouter: \'OpenRouter\''));
});

test('none set -> warn mentioning the scripted/CPU fallback', () => {
  const result = runLlmCheck({ env: {} });
  assert.equal(result.status, 'warn');
  assert.equal(result.id, CHECK_ID);
  assert.equal(result.title, CHECK_TITLE);
  assert.match(result.detail, /no LLM provider key found/);
  assert.ok(result.detail.includes(SCRIPTED_FALLBACK_DETAIL));
  for (const name of llmEnvNames()) {
    assert.ok(result.detail.includes(name), `warn detail names ${name}`);
  }
});

test('empty-string values count as unset -> warn', () => {
  const env = Object.fromEntries(llmEnvNames().map(name => [name, '']));
  const result = runLlmCheck({ env });
  assert.equal(result.status, 'warn');
});

// describeEnv (and resolveProvider in packages/llm/src/presets.ts) treat any
// non-empty string as present, so a whitespace-only value counts as set - the
// check mirrors that repo semantics rather than inventing a stricter rule.

test('one set -> ok naming the provider, with no part of the key', () => {
  const result = runLlmCheck({ env: { OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY } });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /OpenRouter/);
  assert.ok(result.detail.includes('OPENROUTER_API_KEY'));
  assertNoSecretLeak(result, FAKE_OPENROUTER_KEY);
});

test('the opencode-go fallback env name is honoured', () => {
  const result = runLlmCheck({ env: { OPENCODE_GO_API_KEY: FAKE_OPENCODE_FALLBACK } });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /OpenCode Go/);
  assert.ok(result.detail.includes('OPENCODE_GO_API_KEY'));
  assertNoSecretLeak(result, FAKE_OPENCODE_FALLBACK);
});

test('the custom provider key is reported', () => {
  const result = runLlmCheck({ env: { COMFYRIZZ_CUSTOM_API_KEY: FAKE_CUSTOM_KEY } });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /Custom/);
  assert.ok(result.detail.includes('COMFYRIZZ_CUSTOM_API_KEY'));
  assertNoSecretLeak(result, FAKE_CUSTOM_KEY);
});

test('several set -> ok naming every configured provider, values never leak', () => {
  const env = {
    OPENCODE_API_KEY: FAKE_OPENCODE_KEY,
    OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
    COMFYRIZZ_CUSTOM_API_KEY: FAKE_CUSTOM_KEY,
  };
  const result = runLlmCheck({ env });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /OpenCode Go/);
  assert.match(result.detail, /OpenRouter/);
  assert.match(result.detail, /Custom/);
  assertNoSecretLeak(result, FAKE_OPENCODE_KEY, FAKE_OPENROUTER_KEY, FAKE_CUSTOM_KEY);
});

test('a key that looks like sk-... never survives either', () => {
  const fake = 'sk-FAKEllmdoctor0001';
  const result = runLlmCheck({ env: { OPENROUTER_API_KEY: fake } });
  assert.equal(result.status, 'ok');
  assertNoSecretLeak(result, fake);
  assert.ok(result.detail.includes('OpenRouter'));
});

test('the check never mutates the injected env', () => {
  const env = { OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY, UNRELATED: 'plain' };
  const snapshot = { ...env };
  runLlmCheck({ env });
  assert.deepEqual(env, snapshot);
});

test('describeProviders reports set/unset only, never values', () => {
  const env = { OPENCODE_API_KEY: FAKE_OPENCODE_KEY };
  const described = describeProviders(env);
  assert.equal(described.length, PROVIDERS.length);
  const opencode = described.find(provider => provider.id === 'opencode-go');
  assert.equal(opencode.configured, true);
  assert.deepEqual(opencode.envs, [
    { name: 'OPENCODE_API_KEY', state: 'set' },
    { name: 'OPENCODE_GO_API_KEY', state: 'unset' },
  ]);
  const dump = JSON.stringify(described);
  assert.ok(!dump.includes(FAKE_OPENCODE_KEY));
  for (const row of opencode.envs) {
    assert.deepEqual(Object.keys(row), ['name', 'state']);
  }
});

test('describeEnv output for the repo env names has no value field', () => {
  const env = { OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY };
  const rows = describeEnv(env, llmEnvNames());
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ['name', 'state']);
  }
  assertNoSecretLeak({ rows }, FAKE_OPENROUTER_KEY);
});

test('a missing ctx/env object is safe -> warn', () => {
  assert.equal(runLlmCheck().status, 'warn');
  assert.equal(runLlmCheck({}).status, 'warn');
  assert.equal(runLlmCheck({ env: null }).status, 'warn');
});

test('the warn result carries a fix hint pointing at the doctor docs', () => {
  const result = runLlmCheck({ env: {} });
  assert.ok(result.fix.length > 0);
  assert.match(result.fix, /docs\/specs\/DOCTOR\.md/);
});
