import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createApp } from '../src/app.mjs';
import { createHfTokenSettings, HF_MODEL_REPOSITORIES } from '../src/hf-token-settings.mjs';

const TOKEN = 'hf_1234567890abcdefghijklmnopqrstuvwxyz';
const SESSION = 'hf-settings-test-session-token';

function space(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-hf-settings-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('save is fixed-file and atomic, presence is not readiness, and probes only the two gated repos', async t => {
  const runtimeDir = space(t);
  const env = {};
  const calls = [];
  const settings = createHfTokenSettings({
    runtimeDir,
    env,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 200 });
    },
  });

  assert.throws(() => settings.save({ token: TOKEN, path: '/tmp/browser-selected' }), /fixed by the server/);
  assert.equal(existsSync('/tmp/browser-selected'), false);
  const saved = settings.save({ token: TOKEN });
  assert.equal(saved.tokenPresent, true);
  assert.equal(saved.tokenReady, false);
  assert.equal(saved.tokenChecked, false);
  assert.equal(saved.checkedAt, null);
  assert.equal(env.COMFYRIZZ_HF_TOKEN_FILE, join(runtimeDir, 'hf-token'));
  assert.equal(readFileSync(env.COMFYRIZZ_HF_TOKEN_FILE, 'utf8'), `${TOKEN}\n`);
  if (process.platform !== 'win32') assert.equal(statSync(env.COMFYRIZZ_HF_TOKEN_FILE).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(saved).includes(TOKEN), false);
  assert.equal('token' in saved, false);
  assert.equal('managedPath' in saved, false);

  const checked = await settings.probe();
  assert.equal(checked.tokenPresent, true);
  assert.equal(checked.tokenChecked, true);
  assert.equal(checked.tokenReady, true);
  assert.equal(checked.repositories.every(repo => repo.ok === true), true);
  assert.deepEqual(calls.map(call => call.url), HF_MODEL_REPOSITORIES.map(repo => repo.apiUrl));
  for (const call of calls) {
    const parsed = new URL(call.url);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.host, 'huggingface.co');
    assert.match(parsed.pathname, /^\/api\/models\//);
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(call.options.signal instanceof AbortSignal);
  }

  // Saving a replacement invalidates readiness for the old token immediately.
  settings.save({ token: `${TOKEN}replacement` });
  assert.equal(settings.status().tokenPresent, true);
  assert.equal(settings.status().tokenReady, false);
  assert.equal(settings.status().tokenChecked, false);
  const removed = settings.remove();
  assert.equal(removed.tokenPresent, false);
  assert.equal(removed.tokenReady, false);
  assert.equal(env.COMFYRIZZ_HF_TOKEN_FILE, undefined);
  assert.equal(existsSync(join(runtimeDir, 'hf-token')), false);
});

test('a saved token survives recreation without carrying forward unverified readiness', async t => {
  const runtimeDir = space(t);
  createHfTokenSettings({ runtimeDir, env: {} }).save({ token: TOKEN });
  const env = {};
  const reopened = createHfTokenSettings({
    runtimeDir,
    env,
    fetch: async () => new Response(null, { status: 200 }),
  });
  assert.equal(env.COMFYRIZZ_HF_TOKEN_FILE, join(runtimeDir, 'hf-token'));
  assert.equal(reopened.status().tokenPresent, true);
  assert.equal(reopened.status().tokenReady, false);
  const checked = await reopened.probe();
  assert.equal(checked.tokenChecked, true);
  assert.equal(checked.tokenReady, true);
});

test('a denied licence is checked but not ready, and network failure is never readiness', async t => {
  const runtimeDir = space(t);
  let failNetwork = false;
  const settings = createHfTokenSettings({
    runtimeDir,
    env: {},
    fetch: async url => {
      if (failNetwork) throw new Error(`do not expose ${TOKEN}`);
      return new Response(null, { status: url.includes('LTX') ? 403 : 200 });
    },
  });
  settings.save({ token: TOKEN });
  const denied = await settings.probe();
  assert.equal(denied.tokenChecked, true);
  assert.equal(denied.tokenReady, false);
  assert.equal(denied.repositories.find(repo => repo.id.includes('LTX')).status, 'denied');
  assert.match(denied.repositories.find(repo => repo.id.includes('LTX')).detail, /licence/);

  failNetwork = true;
  const failed = await settings.probe();
  assert.equal(failed.tokenChecked, false);
  assert.equal(failed.tokenReady, false);
  assert.equal(JSON.stringify(failed).includes(TOKEN), false);
  assert.equal(failed.repositories.every(repo => repo.status === 'error'), true);
});

test('Windows storage copy does not claim POSIX permissions', t => {
  const settings = createHfTokenSettings({ runtimeDir: space(t), env: {}, platform: 'win32' });
  assert.match(settings.status().storageNote, /Windows uses the runtime folder’s inherited ACL/);
  assert.match(settings.status().storageNote, /0600 mode bits do not apply/);
});

test('HF settings routes require auth and same origin, never return the token, and update backend path immediately', async t => {
  const runtimeDir = space(t);
  const env = {};
  const calls = [];
  const hfTokenSettings = createHfTokenSettings({
    runtimeDir,
    env,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 200 });
    },
  });
  const app = createApp({
    token: SESSION,
    runtimeDir,
    hfTokenSettings,
    backendFactory: async () => ({
      preflight: async () => ({ ok: true, cliVersion: 'test', usage: { balance: 10 }, problems: [], hfToken: { present: true } }),
    }),
  });
  t.after(() => app.close());
  const base = await listen(t, app.handler);
  const api = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'x-comfyrizz-token': SESSION,
        origin: base,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await api('/api/hf/settings', { headers: { 'x-comfyrizz-token': '' } })).status, 401);
  assert.equal((await api('/api/hf/settings', { method: 'PUT', body: { token: TOKEN }, headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal(existsSync(join(runtimeDir, 'hf-token')), false);

  const saved = await api('/api/hf/settings', { method: 'PUT', body: { token: TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.tokenPresent, true);
  assert.equal(saved.body.tokenReady, false);
  assert.equal(JSON.stringify(saved).includes(TOKEN), false);
  assert.equal(env.COMFYRIZZ_HF_TOKEN_FILE, join(runtimeDir, 'hf-token'));

  const probed = await api('/api/hf/settings/probe', { method: 'POST' });
  assert.equal(probed.status, 200);
  assert.equal(probed.body.tokenChecked, true);
  assert.equal(probed.body.tokenReady, true);
  assert.equal(calls.length, 2);
  assert.equal(probed.body.repositories.every(repo => repo.url.startsWith('https://huggingface.co/')), true);

  const colab = await api('/api/colab/status');
  assert.equal(colab.status, 200);
  assert.equal(colab.body.tokenPresent, true);
  assert.equal(colab.body.tokenChecked, true);
  assert.equal(colab.body.tokenReady, true);

  const deleted = await api('/api/hf/settings', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.tokenPresent, false);
  assert.equal(deleted.body.tokenReady, false);
  assert.equal(JSON.stringify(deleted).includes(TOKEN), false);
});
