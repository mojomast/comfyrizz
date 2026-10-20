import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, TOKEN_KEY, createApi, sessionToken } from '../src/demo/api.mjs';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function response(body, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  return new Response(body === undefined ? null : JSON.stringify(body), { ...init, headers });
}

function recorder() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return response({ ok: true, path: url });
  };
  return { calls, fetch };
}

test('sessionToken stores the fragment token and strips it from location', () => {
  const location = { hash: '#token=abc123&other=1', pathname: '/demo.html', search: '?fixture=1' };
  const storage = memoryStorage();
  const token = sessionToken(location, storage);

  assert.equal(token, 'abc123');
  assert.equal(storage.getItem(TOKEN_KEY), 'abc123');
  assert.equal(location.hash, '');
});

test('sessionToken uses history.replaceState when it is available', (t) => {
  const calls = [];
  const original = globalThis.history;
  globalThis.history = { replaceState: (...args) => calls.push(args) };
  t.after(() => {
    if (original === undefined) delete globalThis.history;
    else globalThis.history = original;
  });

  const location = { hash: '#token=frag', pathname: '/demo.html', search: '?fixture=1' };
  assert.equal(sessionToken(location, memoryStorage()), 'frag');
  assert.deepEqual(calls, [[null, '', '/demo.html?fixture=1']]);
});

test('sessionToken falls back to the stored token when there is no fragment', () => {
  const storage = memoryStorage({ [TOKEN_KEY]: 'stored-token' });
  assert.equal(sessionToken({ hash: '', pathname: '/demo.html', search: '' }, storage), 'stored-token');
});

test('only the fragment token with a non-empty value is stored', () => {
  const storage = memoryStorage({ [TOKEN_KEY]: 'old' });
  assert.equal(sessionToken({ hash: '#other=1' }, storage), 'old');
  assert.equal(storage.getItem(TOKEN_KEY), 'old');
});

test('every helper sends the token header and never puts the token in the URL', async () => {
  const { calls, fetch } = recorder();
  const api = createApi({ fetch, baseUrl: 'http://127.0.0.1:4319', token: 'secret-token' });

  await api.agent('make a launch video', [{ role: 'user', content: 'hi' }]);
  await api.brief({ prompt: 'launch' });
  await api.sceneChips('pkg_1');
  await api.scenePlan({ packageId: 'pkg_1', sceneId: 's1' });
  await api.sceneRender({ packageId: 'pkg_1', sceneId: 's1' });
  await api.run({ packageId: 'pkg_1', backendId: 'colab' });
  await api.approve({ planHash: 'abc' });
  await api.runs();
  await api.colabStatus();
  await api.providers();
  await api.health();

  const expected = [
    ['POST', '/api/agent'],
    ['POST', '/api/brief'],
    ['GET', '/api/scene/chips'],
    ['POST', '/api/scene/plan'],
    ['POST', '/api/scene/render'],
    ['POST', '/api/run'],
    ['POST', '/api/run/approve'],
    ['GET', '/api/run'],
    ['GET', '/api/colab/status'],
    ['GET', '/api/providers'],
    ['GET', '/api/health'],
  ];

  assert.equal(calls.length, expected.length);
  calls.forEach((call, index) => {
    const [method, path] = expected[index];
    assert.equal(call.url, `http://127.0.0.1:4319${path}`, `call ${index} path`);
    assert.equal(call.init.method, method, `call ${index} method`);
    assert.equal(call.init.headers['x-comfyrizz-token'], 'secret-token', `call ${index} token header`);
    assert.ok(!call.url.includes('secret-token'), `call ${index} must not put the token in the URL`);
  });

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    brief: 'make a launch video',
    history: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].init.body), { prompt: 'launch' });
  assert.equal(calls[2].init.body, undefined, 'GET requests have no body');
});

test('request throws ApiError with status and the server error text', async () => {
  const fetch = async () => response({ error: 'prompt is required' }, { status: 400 });
  const api = createApi({ fetch, token: 't' });

  await assert.rejects(api.brief({}), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.name, 'ApiError');
    assert.equal(error.status, 400);
    assert.equal(error.message, 'prompt is required');
    assert.deepEqual(error.body, { error: 'prompt is required' });
    return true;
  });
});

test('request falls back to the raw text for non-JSON errors', async () => {
  const fetch = async () => new Response('plain failure', {
    status: 502,
    headers: { 'content-type': 'text/plain' },
  });
  const api = createApi({ fetch, token: 't' });

  await assert.rejects(api.health(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.message, 'plain failure');
    return true;
  });
});

test('request uses the status text when an error body is empty', async () => {
  const fetch = async () => new Response(null, { status: 503, statusText: 'Service Unavailable' });
  const api = createApi({ fetch, token: 't' });

  await assert.rejects(api.health(), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.message, 'Service Unavailable');
    return true;
  });
});

test('request parses JSON without a content-type header', async () => {
  const fetch = async () => new Response(new TextEncoder().encode(JSON.stringify({ ok: true })), { status: 200 });
  const api = createApi({ fetch, token: 't' });
  assert.deepEqual(await api.health(), { ok: true });
});

test('sceneRender resolves to a Blob for the server video response', async () => {
  const fetch = async () => new Response(new Blob(['mp4-bytes'], { type: 'video/mp4' }), {
    status: 200,
    headers: { 'content-type': 'video/mp4' },
  });
  const api = createApi({ fetch, token: 't' });
  const result = await api.sceneRender({ packageId: 'pkg_1', sceneId: 's1' });
  assert.ok(result instanceof Blob);
  assert.equal(result.type, 'video/mp4');
});

test('the client sessionToken method adopts the fragment token for later calls', async () => {
  const { calls, fetch } = recorder();
  const api = createApi({ fetch, token: null });
  const storage = memoryStorage();

  const adopted = api.sessionToken({ hash: '#token=from-url', pathname: '/demo.html', search: '' }, storage);
  assert.equal(adopted, 'from-url');
  assert.equal(api.getToken(), 'from-url');
  assert.equal(storage.getItem(TOKEN_KEY), 'from-url');

  await api.health();
  assert.equal(calls[0].init.headers['x-comfyrizz-token'], 'from-url');
});

test('no token header is sent when there is no token', async () => {
  const { calls, fetch } = recorder();
  const api = createApi({ fetch, token: null });
  await api.health();
  assert.equal(calls[0].init.headers['x-comfyrizz-token'], undefined);
});

test('createApi requires a fetch implementation', (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = undefined;
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.throws(() => createApi({ token: 't' }), /fetch implementation/);
});
