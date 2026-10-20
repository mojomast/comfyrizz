import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, describeEnv, SECRET_PATTERNS, SECRET_NAME_PATTERN, REDACTED } from './redact.mjs';

const FAKE_KEY = 'FAKE-comfyrizz-key-0001';
const FAKE_TOKEN = 'FAKE-comfyrizz-token-0002';
const FAKE_PASSWORD = 'FAKE-comfyrizz-pw-0003';
const FAKE_SECRET = 'FAKE-comfyrizz-secret-0004';
const FAKE_PLAIN = 'plain-visible-value-0005';
const FAKE_SK = 'sk-FAKE0001';
const FAKE_HF = 'hf_FAKE0001';
const FAKE_GHP = 'ghp_FAKE0001';
const FAKE_BEARER = 'Bearer FAKE0001token';

test('redact removes every matching env value wherever it appears', () => {
  const env = {
    OPENAI_API_KEY: FAKE_KEY,
    GITHUB_TOKEN: FAKE_TOKEN,
    DB_PASSWORD: FAKE_PASSWORD,
    PRIVATE_SECRET: FAKE_SECRET,
  };
  const text = `start ${FAKE_KEY} mid ${FAKE_TOKEN} again ${FAKE_KEY} ${FAKE_PASSWORD} ${FAKE_SECRET} end`;
  const out = redact(text, env);
  for (const value of Object.values(env)) {
    assert.ok(!out.includes(value), 'env secret value must never survive');
  }
  assert.equal(out.split(REDACTED).length - 1, 5);
  assert.equal(out.startsWith('start '), true);
  assert.equal(out.endsWith(' end'), true);
});

test('redact replaces an env value embedded inside longer text', () => {
  const out = redact(`prefix-${FAKE_KEY}-suffix`, { DEMO_API_KEY: FAKE_KEY });
  assert.equal(out, `prefix-${REDACTED}-suffix`);
});

test('values of env names that do not match stay visible', () => {
  const env = { COMFYRIZZ_PORT: FAKE_PLAIN, PATH_EXTRA: FAKE_PLAIN };
  assert.equal(redact(`port=${FAKE_PLAIN}`, env), `port=${FAKE_PLAIN}`);
});

test('short and empty env values are left alone', () => {
  for (const value of ['', 'a', 'abc', 'abcde']) {
    assert.equal(redact(`x ${value} y`, { DEMO_API_KEY: value }), `x ${value} y`);
  }
  assert.equal(redact('x abcdef y', { DEMO_API_KEY: 'abcdef' }), `x ${REDACTED} y`);
});

test('env values are matched as literal text, not as patterns', () => {
  const value = 'a.b+c$d[1](2)';
  assert.equal(redact(`before ${value} after`, { NEON_KEY: value }), `before ${REDACTED} after`);
});

test('generic patterns redact sk-, hf_, ghp_ and Bearer credentials', () => {
  const text = `a ${FAKE_SK} b ${FAKE_HF} c ${FAKE_GHP} d ${FAKE_BEARER} e`;
  const out = redact(text, {});
  for (const sample of [FAKE_SK, FAKE_HF, FAKE_GHP, FAKE_BEARER]) {
    assert.ok(!out.includes(sample), 'pattern-matched credential must never survive');
  }
  assert.equal(out.split(REDACTED).length - 1, 4);
});

test('pattern list covers sk-, hf_, ghp_ and Bearer', () => {
  const sources = SECRET_PATTERNS.map(pattern => String(pattern.re ?? pattern.source ?? pattern)).join(' ');
  assert.ok(sources.includes('sk-'));
  assert.ok(sources.includes('hf_'));
  assert.ok(sources.includes('ghp_'));
  assert.match(sources, /Bearer/i);
  assert.equal(SECRET_PATTERNS.length >= 4, true);
  for (const sample of [FAKE_SK, FAKE_HF, FAKE_GHP, FAKE_BEARER]) {
    assert.equal(SECRET_PATTERNS.some(pattern => pattern.re.test(sample)), true, sample);
  }
});

test('secret name pattern matches KEY, TOKEN, SECRET and PASSWORD anywhere in the name', () => {
  for (const name of ['API_KEY', 'github_token', 'MySecret', 'db_password', 'xKeYx']) {
    assert.equal(SECRET_NAME_PATTERN.test(name), true, name);
  }
  for (const name of ['PATH', 'PORT', 'HOME', 'COMFYRIZZ_URL']) {
    assert.equal(SECRET_NAME_PATTERN.test(name), false, name);
  }
});

test('ordinary text without secrets is unchanged', () => {
  const text = 'node 22, pnpm 9, python 3.12, task-12345, disk-cache-1, Bearer of good news';
  assert.equal(redact(text, {}), text);
  assert.equal(redact(text), text);
});

test('redact never mixes real env into the result', () => {
  const env = { HOME_DIR: '/tmp/elsewhere', OPENAI_API_KEY: FAKE_KEY };
  const out = redact(`home ok, key ${FAKE_KEY}`, env);
  assert.ok(!out.includes(FAKE_KEY));
  assert.ok(out.includes('home ok'));
});

test('describeEnv reports only names and set/unset, never values', () => {
  const env = {
    OPENAI_API_KEY: FAKE_KEY,
    GITHUB_TOKEN: FAKE_TOKEN,
    EMPTY_SECRET: '',
    COMFYRIZZ_PORT: '4319',
  };
  const rows = describeEnv(env, ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'EMPTY_SECRET', 'MISSING_TOKEN']);
  assert.deepEqual(rows, [
    { name: 'OPENAI_API_KEY', state: 'set' },
    { name: 'GITHUB_TOKEN', state: 'set' },
    { name: 'EMPTY_SECRET', state: 'unset' },
    { name: 'MISSING_TOKEN', state: 'unset' },
  ]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ['name', 'state']);
  }
  const dump = JSON.stringify(rows);
  for (const value of [FAKE_KEY, FAKE_TOKEN]) {
    assert.ok(!dump.includes(value), 'describeEnv must never contain values');
  }
});

test('describeEnv with no names returns an empty list and does not mutate env', () => {
  const env = { OPENAI_API_KEY: FAKE_KEY };
  assert.deepEqual(describeEnv(env, []), []);
  assert.deepEqual(describeEnv(), []);
  assert.deepEqual(env, { OPENAI_API_KEY: FAKE_KEY });
});

test('describeEnv output passes through redact unchanged', () => {
  const env = { OPENAI_API_KEY: FAKE_KEY };
  const rows = describeEnv(env, ['OPENAI_API_KEY', 'MISSING_SECRET']);
  const json = JSON.stringify(rows);
  assert.equal(redact(json, env), json);
  assert.ok(!json.includes(FAKE_KEY));
});
