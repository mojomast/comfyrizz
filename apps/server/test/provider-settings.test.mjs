import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderSettings } from '../src/provider-settings.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { createApp } from '../src/app.mjs';
import { defaultCpuScript } from '../../../packages/agent/dist/src/index.js';

const TOKEN = 'provider-settings-test-session-token';
const SECRET = 'test-private-provider-key-123456';
function setup(t, options = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-providers-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return { runtimeDir, settings: createProviderSettings({ runtimeDir, env: {}, ...options }) };
}
async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function startApp(t, settings, runtimeDir, agentRunner) {
  const app = createApp({ token: TOKEN, runtimeDir, providerSettings: settings, agentRunner });
  t.after(() => app.close());
  const base = await listen(t, app.handler);
  return async (path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-comfyrizz-token': TOKEN, origin: base, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('keys persist privately, are write-only, and blank updates preserve them', t => {
  const { settings, runtimeDir } = setup(t);
  const result = settings.save({ id: 'opencode-go', apiKey: SECRET, model: 'deepseek-v4.1-flash', use: true });
  assert.equal(result.profiles.find(item => item.id === 'opencode-go').keySource, 'saved');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(statSync(join(runtimeDir, 'provider-settings.json')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(runtimeDir, 'provider-settings.json'), 'utf8'), new RegExp(SECRET));
  const reloaded = createProviderSettings({ runtimeDir, env: {} });
  assert.deepEqual(reloaded.snapshot().active, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
  reloaded.save({ id: 'opencode-go', apiKey: '', label: 'My Go' });
  const resolved = reloaded.resolve('opencode-go');
  assert.equal(resolved.apiKey, SECRET);
  assert.equal(resolved.headers['User-Agent'], 'comfyrizz/0.1');
  assert.equal(resolved.sessionHeader, 'x-opencode-session');
  reloaded.save({ id: 'opencode-go', clearApiKey: true });
  assert.equal(reloaded.snapshot().profiles.find(item => item.id === 'opencode-go').hasApiKey, false);
});

test('saved keys override environment keys; removal restores environment configuration', t => {
  const { settings } = setup(t, { env: { OPENCODE_GO_API_KEY: 'environment-key', COMFYRIZZ_CUSTOM_BASE_URL: 'http://127.0.0.1:9999/v1' } });
  assert.equal(settings.resolve('opencode-go').apiKey, 'environment-key');
  assert.equal(settings.snapshot().profiles.find(item => item.id === 'custom').baseUrl, 'http://127.0.0.1:9999/v1');
  settings.save({ id: 'opencode-go', apiKey: SECRET });
  assert.equal(settings.resolve('opencode-go').apiKey, SECRET);
  settings.save({ id: 'opencode-go', clearApiKey: true });
  assert.equal(settings.resolve('opencode-go').apiKey, 'environment-key');
});

test('multiple named connections retain independent models and endpoints across restarts', t => {
  const { settings, runtimeDir } = setup(t);
  const a = settings.save({ label: 'Local A', preset: 'custom', baseUrl: 'http://127.0.0.1:8001/v1', model: 'model-a' }).savedId;
  const b = settings.save({ label: 'Local B', preset: 'custom', baseUrl: 'http://127.0.0.1:8002/v1', model: 'model-b' }).savedId;
  settings.select({ provider: a, model: 'model-a2' });
  const restored = createProviderSettings({ runtimeDir, env: {} });
  assert.deepEqual(restored.snapshot().active, { provider: a, model: 'model-a2' });
  assert.equal(restored.resolve(a).model, 'model-a2');
  assert.equal(restored.resolve(b).baseUrl, 'http://127.0.0.1:8002/v1');
  assert.equal(restored.resolve(b).model, 'model-b');
  restored.remove(a);
  assert.deepEqual(restored.snapshot().active, { provider: 'none', model: '' });
  assert.throws(() => restored.resolve(a), /Unknown provider/);
  assert.throws(() => restored.remove('opencode-go'), /Built-in/);
});

test('invalid endpoint or provider input cannot overwrite valid settings', t => {
  const { settings } = setup(t);
  for (const baseUrl of ['file:///tmp/test', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret']) {
    assert.throws(() => settings.save({ baseUrl }), /URL/);
  }
  assert.throws(() => settings.save({ preset: '__proto__' }), /Unknown provider preset/);
  assert.throws(() => settings.save({ id: '../../escape' }), /Unknown provider/);
  assert.throws(() => settings.select({ provider: 'custom', model: '' }), /Choose a model/);
  assert.throws(() => settings.save({ id: 'opencode-go', use: true }), /Add an API key/);
  assert.throws(() => settings.select({ provider: 'opencode-go' }), /Add an API key/);
  assert.deepEqual(settings.snapshot().active, { provider: 'none', model: '' });
});

test('settings API requires authentication and same origin, and returns no credentials', async t => {
  const { settings, runtimeDir } = setup(t);
  const api = await startApp(t, settings, runtimeDir);
  assert.equal((await api('/api/agent/settings', undefined, { 'x-comfyrizz-token': '' })).status, 401);
  assert.equal((await api('/api/agent/settings', { action: 'save', id: 'opencode-go' }, { origin: 'https://other.example' })).status, 403);
  const saved = await api('/api/agent/settings', { action: 'save', id: 'opencode-go', apiKey: SECRET, use: true });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved).includes(SECRET));
  assert.equal((await api('/api/providers')).body.providers['opencode-go'], true);
  assert.equal((await api('/api/agent/settings', null)).status, 400);
  assert.equal((await api('/api/agent/settings', { action: 'unknown' })).status, 400);
  assert.equal((await api('/api/agent/probe', { provider: 'missing', model: 'x' })).status, 400);
});

test('discovery and tool probe use the saved endpoints, key, model and OpenCode session headers', async t => {
  const seen = [];
  const upstream = await listen(t, async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ path: request.url, headers: request.headers, body });
    if (request.url === '/catalog') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'test-model' }] }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    const delta = body.tools?.length ? { tool_calls: [{ index: 0, id: 'ping', function: { name: 'comfyrizz_probe_ping', arguments: '{"value":"pong"}' } }] } : { content: 'pong' };
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: body.tools?.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const { settings, runtimeDir } = setup(t);
  const api = await startApp(t, settings, runtimeDir);
  await api('/api/agent/settings', { action: 'save', id: 'opencode-go', apiKey: SECRET, baseUrl: `${upstream}/v1`, modelsUrl: `${upstream}/catalog`, model: 'test-model' });
  assert.deepEqual((await api('/api/agent/models?provider=opencode-go')).body.models, ['test-model']);
  assert.deepEqual((await api('/api/agent/probe', { provider: 'opencode-go', model: 'test-model' })).body, { ok: true, model: 'test-model' });
  const chat = seen.filter(item => item.path === '/v1/chat/completions');
  assert.equal(chat.length, 2);
  for (const item of chat) {
    assert.equal(item.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(item.headers['user-agent'], 'comfyrizz/0.1');
    assert.ok(item.headers['x-opencode-session']);
    assert.equal(item.body.model, 'test-model');
  }
  assert.equal(chat[1].body.messages.at(-1).role, 'tool');
});

test('provider errors cannot echo a stored key through the probe API', async t => {
  const upstream = await listen(t, (request, response) => {
    response.writeHead(401);
    response.end(`Rejected credential ${SECRET}`);
  });
  const { settings, runtimeDir } = setup(t);
  settings.save({ id: 'custom', baseUrl: `${upstream}/v1`, apiKey: SECRET, model: 'test' });
  const api = await startApp(t, settings, runtimeDir);
  const result = await api('/api/agent/probe', { provider: 'custom' });
  assert.equal(result.body.ok, false);
  assert.match(result.body.reason, /http_401/);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.match(result.body.reason, /\[redacted\]/);
});

test('newly saved named connection and explicit model are used by the real agent runner', async t => {
  const seen = [];
  const brief = 'A short explainer about solar panels.';
  const calls = defaultCpuScript(brief);
  let planningCalls = 0;
  const upstream = await listen(t, async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    seen.push({ headers: request.headers, body: JSON.parse(raw) });
    response.setHeader('content-type', 'text/event-stream');
    const isSvg = seen.at(-1).body.messages?.some(message => message.role === 'system' && message.content?.includes('one standalone SVG document'));
    if (isSvg) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#f2f2f2"/><text x="10" y="60" fill="#050505">Solar</text></svg>';
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: svg }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const call = calls[planningCalls++];
    const delta = call ? { tool_calls: [{ index: 0, id: `call-${seen.length}`, function: { name: call.name.replace(/[^a-zA-Z0-9_-]/g, '_'), arguments: JSON.stringify(call.args) } }] } : { content: 'done' };
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const { settings, runtimeDir } = setup(t);
  const runner = createCpuAgentRunner({ runtimeDir, resolveProviderConfig: settings.resolve });
  const api = await startApp(t, settings, runtimeDir, runner);
  const saved = await api('/api/agent/settings', { action: 'save', label: 'New provider', preset: 'custom', baseUrl: `${upstream}/v1`, apiKey: SECRET, model: 'saved-model', use: true });
  const result = await api('/api/agent', { brief, provider: saved.body.savedId, model: 'chosen-model' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.provider, saved.body.savedId);
  assert.equal(result.body.model, 'chosen-model');
  assert.equal(result.body.live, true);
  assert.equal(result.body.fallback, false);
  assert.ok(seen.length > 0);
  assert.equal(seen[0].body.model, 'chosen-model');
  assert.equal(seen[0].headers.authorization, `Bearer ${SECRET}`);
  const svgCalls = seen.filter(item => item.body.messages?.some(message => message.role === 'system' && message.content?.includes('one standalone SVG document')));
  assert.equal(svgCalls.length, 4);
  assert.ok(svgCalls.every(item => item.body.model === 'chosen-model' && item.headers.authorization === `Bearer ${SECRET}` && item.body.max_tokens === 2048));
});
