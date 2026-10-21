import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AUTH_PROBE_ARGS,
  CHECK_ID,
  CHECK_TITLE,
  COLAB_BIN_ENV,
  DEFAULT_TIMEOUT_MS,
  classifyAuthProbe,
  parseUsageBalance,
  redactAuthText,
  resolveColabBin,
  runColabAuthCheck,
} from './check-colab-auth.mjs';

// Fake credentials for the tests. These must never appear in any check output.
// The oauth value is assembled at runtime so the source tree never holds a token-shaped literal.
const FAKE_OAUTH_TOKEN = `ya${'29.'}FAKE-comfyrizz-oauth-value-0001`;
const FAKE_BEARER = `Bearer ${'FAKE-comfyrizz-bearer-value-0002'}`;
const FAKE_API_CREDENTIAL = `api_key=${'FAKE-comfyrizz-credential-value-0003'}`;
const FAKE_EMAIL = 'demo.user@example.com';

function assertNoSecretLeak(result, ...secrets) {
  const dump = JSON.stringify(result);
  for (const secret of secrets) {
    assert.ok(!dump.includes(secret), `output must not contain the secret value: ${secret.slice(0, 8)}...`);
    for (let i = 0; i + 8 <= secret.length; i += 4) {
      const slice = secret.slice(i, i + 8);
      assert.ok(!dump.includes(slice), `output must not contain a slice of the secret: ${slice}`);
    }
  }
}

function probeExecutor(result = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args: [...args] });
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  exec.calls = calls;
  return exec;
}

function fileProbe(files = []) {
  const known = new Set(files);
  return async (path) => known.has(path);
}

test('the check identity is stable', () => {
  assert.equal(CHECK_ID, 'colab-auth');
  assert.equal(CHECK_TITLE, 'Google Colab auth');
  assert.deepEqual([...AUTH_PROBE_ARGS], ['usage']);
  assert.equal(COLAB_BIN_ENV, 'COMFYRIZZ_COLAB_BIN');
  assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0);
});

test('the binary is resolved in the backend order: env override, home install, PATH', async () => {
  const env = { [COLAB_BIN_ENV]: '/opt/custom/colab', PATH: '/opt/bin:/usr/local/bin' };
  const home = '/opt/demo-home';
  const exists = fileProbe(['/opt/custom/colab', '/opt/demo-home/.local/bin/colab', '/opt/bin/colab']);

  const fromEnv = await resolveColabBin({ env, home, exists });
  assert.equal(fromEnv.command, '/opt/custom/colab');
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.found, true);

  const fromHome = await resolveColabBin({ env: { PATH: env.PATH }, home, exists });
  assert.equal(fromHome.command, '/opt/demo-home/.local/bin/colab');
  assert.equal(fromHome.source, 'home');
  assert.equal(fromHome.found, true);

  const fromPath = await resolveColabBin({ env: { PATH: env.PATH }, home: '', exists });
  assert.equal(fromPath.command, '/opt/bin/colab');
  assert.equal(fromPath.source, 'path');
  assert.equal(fromPath.found, true);
});

test('a missing binary is reported as missing, and an unknown location stays unknown', async () => {
  const missing = await resolveColabBin({ env: { PATH: '/opt/bin' }, home: '/opt/demo-home', exists: fileProbe([]) });
  assert.equal(missing.found, false);

  const unknown = await resolveColabBin({ env: { PATH: '/opt/bin' }, home: '/opt/demo-home' });
  assert.equal(unknown.found, null);
  assert.equal(unknown.command, 'colab');
});

test('the compute unit balance is parsed from the usage output', () => {
  assert.equal(parseUsageBalance('Current balance: 12.5 compute units'), 12.5);
  assert.equal(parseUsageBalance('Usage rate: 3.5/hr\nCurrent balance: 7 compute units'), 7);
  assert.equal(parseUsageBalance('no balance here'), null);
  assert.equal(parseUsageBalance(''), null);
});

test('the probe output is classified into a sign-in state', () => {
  const signedIn = classifyAuthProbe({ code: 0, stdout: 'Current balance: 4 compute units' });
  assert.equal(signedIn.state, 'signed-in');
  assert.equal(signedIn.balance, 4);

  assert.equal(classifyAuthProbe({ code: 0, stdout: 'You are signed in as demo' }).state, 'signed-in');
  assert.equal(classifyAuthProbe({ code: 1, stdout: '', stderr: 'not signed in: run the sign-in command' }).state, 'signed-out');
  assert.equal(classifyAuthProbe({ code: 1, stdout: '', stderr: 'authentication required' }).state, 'signed-out');
  assert.equal(classifyAuthProbe({ code: 2, stdout: '', stderr: 'boom' }).state, 'error');
  assert.equal(classifyAuthProbe({ code: 0, stdout: 'unremarkable output' }).state, 'unknown');
});

test('credentials, tokens, query parameters and emails are redacted', () => {
  const redacted = redactAuthText([
    `token=${FAKE_OAUTH_TOKEN}`,
    FAKE_BEARER,
    FAKE_API_CREDENTIAL,
    'https://example.test/callback?access_token=FAKE-comfyrizz-query-value-0004',
    `account ${FAKE_EMAIL}`,
  ].join('\n'));

  assert.ok(!redacted.includes(FAKE_OAUTH_TOKEN));
  assert.ok(!redacted.includes('FAKE-comfyrizz-bearer-value-0002'));
  assert.ok(!redacted.includes('FAKE-comfyrizz-credential-value-0003'));
  assert.ok(!redacted.includes('FAKE-comfyrizz-query-value-0004'));
  assert.ok(!redacted.includes(FAKE_EMAIL));
  assert.ok(redacted.includes('[redacted]'));
});

test('a signed in CLI is reported as ok with the balance and nothing else', async () => {
  const exec = probeExecutor({
    stdout: `Current balance: 12.5 compute units\n${FAKE_OAUTH_TOKEN}\n${FAKE_EMAIL}`,
  });
  const result = await runColabAuthCheck({
    exec,
    env: { PATH: '/opt/bin' },
    home: '/opt/demo-home',
    exists: fileProbe(['/opt/bin/colab']),
  });

  assert.equal(result.id, CHECK_ID);
  assert.equal(result.title, CHECK_TITLE);
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /signed in/);
  assert.match(result.detail, /12\.5 compute units/);
  assertNoSecretLeak(result, FAKE_OAUTH_TOKEN, FAKE_EMAIL);
});

test('an installed but signed out CLI is a warn', async () => {
  const exec = probeExecutor({ code: 1, stderr: 'not signed in: run the sign-in command' });
  const result = await runColabAuthCheck({
    exec,
    env: { PATH: '/opt/bin' },
    home: '/opt/demo-home',
    exists: fileProbe(['/opt/bin/colab']),
  });

  assert.equal(result.status, 'warn');
  assert.match(result.detail, /not signed in/);
  assert.ok(result.fix.length > 0);
});

test('a missing CLI is a skip because Google Colab generation is optional', async () => {
  const exec = probeExecutor({ stdout: 'Current balance: 1 compute units' });
  const result = await runColabAuthCheck({
    exec,
    env: { PATH: '/opt/bin' },
    home: '/opt/demo-home',
    exists: fileProbe([]),
  });

  assert.equal(result.status, 'skip');
  assert.match(result.detail, /not found/);
  assert.equal(exec.calls.length, 0, 'a missing CLI is never probed');
});

test('a CLI that cannot be run is a skip, not a failure', async () => {
  const exec = async () => {
    throw new Error('spawn failed');
  };
  const result = await runColabAuthCheck({
    exec,
    env: { PATH: '/opt/bin' },
    home: '/opt/demo-home',
    exists: fileProbe(['/opt/bin/colab']),
  });

  assert.equal(result.status, 'skip');
  assert.match(result.detail, /could not be run/);
});

test('a failing CLI is a warn that names the reason', async () => {
  const exec = probeExecutor({ code: 3, stderr: 'the account is not entitled to this runtime' });
  const result = await runColabAuthCheck({
    exec,
    env: { PATH: '/opt/bin' },
    home: '/opt/demo-home',
    exists: fileProbe(['/opt/bin/colab']),
  });

  assert.equal(result.status, 'warn');
  assert.match(result.detail, /failed the read-only usage query/);
  assert.match(result.detail, /not entitled/);
});

test('offline mode skips the probe entirely', async () => {
  const exec = probeExecutor({ stdout: 'Current balance: 1 compute units' });
  const result = await runColabAuthCheck({
    exec,
    offline: true,
    env: { PATH: '/opt/bin' },
    home: '/opt/demo-home',
    exists: fileProbe(['/opt/bin/colab']),
  });

  assert.equal(result.status, 'skip');
  assert.match(result.detail, /offline/);
  assert.equal(exec.calls.length, 0);
});

test('only the read-only usage query is ever run', async () => {
  const exec = probeExecutor({ stdout: 'Current balance: 1 compute units' });
  await runColabAuthCheck({
    exec,
    env: { PATH: '/opt/bin' },
    home: '/opt/demo-home',
    exists: fileProbe(['/opt/bin/colab']),
  });

  assert.equal(exec.calls.length, 1);
  assert.deepEqual(exec.calls[0].args, ['usage']);
  assert.ok(!exec.calls[0].args.some(arg => /auth/i.test(arg)), 'the sign-in command must never be run');
});

test('the check never spawns a process or reads the environment by itself', () => {
  const source = readFileSync(new URL('./check-colab-auth.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('child_process'), 'the module must not import a process runner');
  assert.ok(!source.includes('process.env'), 'the module must not read the environment directly');
  assert.ok(!/\bspawn\s*\(/.test(source), 'the module must not spawn anything');
  assert.ok(!/\bexecFile\b/.test(source), 'the module must not exec a file directly');
});
