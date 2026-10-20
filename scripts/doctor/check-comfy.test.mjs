import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_ID,
  CHECK_TITLE,
  COMFY_URL_ENV_NAMES,
  DEFAULT_TIMEOUT_MS,
  comfyRoot,
  describeDevice,
  resolveComfyUrl,
  runComfyCheck,
  stripCredentials,
} from './check-comfy.mjs';

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

const SYSTEM_STATS = {
  system: { os: 'linux', python_version: '3.12.1' },
  devices: [{ name: 'NVIDIA GeForce RTX 4090', type: 'cuda', vram_total: 25757220864, vram_free: 24159123456 }],
};

test('unset -> skip', async () => {
  const result = await runComfyCheck({ env: {}, fetch: async () => { throw new Error('must not be called'); } });
  assert.equal(result.status, 'skip');
  assert.match(result.detail, /no own ComfyUI configured \(optional\)/);
  assert.equal(result.id, CHECK_ID);
  assert.equal(result.title, CHECK_TITLE);
});

test('an empty env value counts as unset -> skip', async () => {
  const result = await runComfyCheck({ env: { [COMFY_URL_ENV_NAMES[0]]: '   ' }, fetch: async () => { throw new Error('must not be called'); } });
  assert.equal(result.status, 'skip');
});

test('fake system_stats -> ok with device name and VRAM', async () => {
  const calls = [];
  const result = await runComfyCheck({
    env: { [COMFY_URL_ENV_NAMES[0]]: 'http://127.0.0.1:8188' },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(SYSTEM_STATS);
    },
  });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /NVIDIA GeForce RTX 4090/);
  assert.match(result.detail, /VRAM 23\.99 GB total/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8188/system_stats');
  assert.equal(calls[0].init.method, 'GET');
});

test('the repo-wide COMFYUI_URL variable is honoured too', async () => {
  const result = await runComfyCheck({
    env: { COMFYUI_URL: 'http://127.0.0.1:8188' },
    fetch: async () => jsonResponse(SYSTEM_STATS),
  });
  assert.equal(result.status, 'ok');
});

test('timeout -> warn', async () => {
  const result = await runComfyCheck({
    env: { [COMFY_URL_ENV_NAMES[0]]: 'http://127.0.0.1:8188' },
    timeoutMs: 20,
    fetch: () => new Promise(() => {}),
  });
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /timed out after 20ms/);
});

test('a fetch that hangs is aborted, not left pending', async () => {
  let aborted = false;
  const result = await runComfyCheck({
    env: { [COMFY_URL_ENV_NAMES[0]]: 'http://127.0.0.1:8188' },
    timeoutMs: 20,
    fetch: (url, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    }),
  });
  assert.equal(result.status, 'warn');
  assert.ok(aborted);
});

test('a non-2xx answer -> warn', async () => {
  const result = await runComfyCheck({
    env: { [COMFY_URL_ENV_NAMES[0]]: 'http://127.0.0.1:8188' },
    fetch: async () => jsonResponse({ error: 'nope' }, { ok: false, status: 500 }),
  });
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /500/);
});

test('a payload without a device name -> warn', async () => {
  const result = await runComfyCheck({
    env: { [COMFY_URL_ENV_NAMES[0]]: 'http://127.0.0.1:8188' },
    fetch: async () => jsonResponse({ system: {}, devices: [] }),
  });
  assert.equal(result.status, 'warn');
});

test('URL credentials are stripped from the output', async () => {
  const result = await runComfyCheck({
    env: { [COMFY_URL_ENV_NAMES[0]]: 'http://user:s3cr3t@127.0.0.1:8188' },
    fetch: async () => jsonResponse(SYSTEM_STATS),
  });
  assert.equal(result.status, 'ok');
  assert.doesNotMatch(result.detail, /s3cr3t/);
  assert.doesNotMatch(result.detail, /user:/);
  assert.match(result.detail, /127\.0\.0\.1:8188/);
});

test('credentials are never sent to the server either', async () => {
  let requested = null;
  await runComfyCheck({
    env: { [COMFY_URL_ENV_NAMES[0]]: 'http://user:s3cr3t@127.0.0.1:8188' },
    fetch: async (url) => {
      requested = url;
      return jsonResponse(SYSTEM_STATS);
    },
  });
  assert.doesNotMatch(requested, /s3cr3t/);
});

test('stripCredentials leaves a plain URL alone and never leaks the userinfo part', () => {
  assert.equal(stripCredentials('http://127.0.0.1:8188'), 'http://127.0.0.1:8188/');
  assert.doesNotMatch(stripCredentials('http://user:pass@host:8188/x'), /pass/);
  assert.doesNotMatch(stripCredentials('not a url with user:pass@host'), /pass/);
});

test('comfyRoot trims trailing slashes and credentials', () => {
  assert.equal(comfyRoot('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
  assert.equal(comfyRoot('http://user:pass@127.0.0.1:8188//'), 'http://127.0.0.1:8188');
});

test('resolveComfyUrl prefers the doctor-specific variable', () => {
  assert.equal(resolveComfyUrl({ COMFYRIZZ_COMFYUI_URL: 'http://a', COMFYUI_URL: 'http://b' }), 'http://a');
  assert.equal(resolveComfyUrl({}), '');
});

test('describeDevice reads the first device and its VRAM', () => {
  const described = describeDevice(SYSTEM_STATS);
  assert.equal(described.name, 'NVIDIA GeForce RTX 4090');
  assert.equal(described.vramTotalGb, 23.99);
  assert.equal(described.vramFreeGb, 22.5);
  assert.equal(describeDevice(null).name, '');
});

test('the default timeout is 3 seconds', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 3000);
});
