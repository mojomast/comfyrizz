import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedMockContribution, approveMockContribution } from './helpers/comfy-contribution.mjs';
import { createServer, request as httpRequest, get as httpGet } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));
let runtime;
let app;
let server;
let port;

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-server-'));
  app = createApp({
    root: new URL('../../..', import.meta.url).pathname,
    token: TOKEN,
    runtimeDir: runtime,
    render: async (packagePath, output) => {
      const bytes = Buffer.from('fake mp4 bytes');
      writeFileSync(output, bytes);
      return { output, bytes: bytes.length, frames: 42, hash: 'deadbeef' };
    },
    agentRunner: async ({ brief }) => {
      if (!brief) {
        const error = new Error('brief is required');
        error.status = 400;
        throw error;
      }
      const pkg = structuredClone(seed);
      pkg.id = 'pkg_agenttest0001';
      pkg.revision = 1;
      pkg.title = `Agent: ${brief.slice(0, 40)}`;
      return {
        package: pkg,
        generatedAssets: { a_icon_check: { kind: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#6d8cff"/></svg>' } },
        routes: [{ tool: 'assets.generate_svg' }],
        pendingGpu: [],
        svgAssets: ['a_icon_check'],
        live: false,
      };
    },
  });
  seedMockContribution(app.store, JSON.parse(JSON.stringify(seed)));
  cpSync(new URL('../../../examples/launch-demo/assets/', import.meta.url), join(app.store.dir, 'assets'), { recursive: true });
  approveMockContribution(app.takeStore, app.store.read(seed.id), app.store.dir);
  server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  app.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(runtime, { recursive: true, force: true });
});

function request({ method = 'GET', path = '/', token = TOKEN, origin = `http://127.0.0.1:${port}`, host = `127.0.0.1:${port}`, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = requestRaw({ method, path, token, origin, host, payload, headers });
    req.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function requestRaw({ method, path, token, origin, host, payload, headers }) {
  const allHeaders = { ...headers };
  if (token) allHeaders['x-comfyrizz-token'] = token;
  if (origin) allHeaders.origin = origin;
  if (host) allHeaders.host = host;
  if (payload !== undefined) allHeaders['content-type'] = 'application/json';
  allHeaders['content-length'] = payload === undefined ? undefined : Buffer.byteLength(payload);
  for (const key of Object.keys(allHeaders)) if (allHeaders[key] === undefined) delete allHeaders[key];
  return httpRequest({ hostname: '127.0.0.1', port, path, method, headers: allHeaders });
}

test('health is public but host-checked', async () => {
  const ok = await request({ path: '/api/health', token: null });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  const bad = await request({ path: '/api/health', token: null, host: 'evil.example' });
  assert.equal(bad.status, 403);
});

test('/api/providers is authenticated and reports key presence only', async () => {
  assert.equal((await request({ path: '/api/providers', token: null })).status, 401);
  const ok = await request({ path: '/api/providers' });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json.providers).sort(), ['custom', 'opencode-go', 'openrouter']);
  for (const value of Object.values(ok.json.providers)) assert.equal(typeof value, 'boolean');
});

test('rejects missing/wrong token and wrong Host', async () => {
  assert.equal((await request({ path: '/api/package/pkg_launchdemo0001', token: null })).status, 401);
  assert.equal((await request({ path: '/api/package/pkg_launchdemo0001', token: 'nope' })).status, 401);
  assert.equal((await request({ path: '/api/package/pkg_launchdemo0001', host: 'evil.example' })).status, 403);
});

test('GET package exposes revision', async () => {
  const response = await request({ path: '/api/package/pkg_launchdemo0001' });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.revision, 1);
  assert.equal(response.json.package.id, 'pkg_launchdemo0001');
});

test('PATCH requires same-origin and a live base revision', async () => {
  assert.equal((await request({ method: 'PATCH', path: '/api/package/pkg_launchdemo0001', origin: 'http://evil.example', body: { baseRevision: 1, package: seed } })).status, 403);
  assert.equal((await request({ method: 'PATCH', path: '/api/package/pkg_launchdemo0001', origin: null, body: { baseRevision: 1, package: seed } })).status, 403);
  const stale = await request({ method: 'PATCH', path: '/api/package/pkg_launchdemo0001', body: { baseRevision: 99, package: seed } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.currentRevision, 1);
});

test('the private owner demo accepts a same-host HTTP origin, while hosted requires HTTPS', async () => {
  const savedHosts = process.env.COMFYRIZZ_ALLOWED_HOSTS;
  const savedHosted = process.env.COMFYRIZZ_HOSTED_INVITES;
  process.env.COMFYRIZZ_ALLOWED_HOSTS = 'demo.example:4404';
  try {
    delete process.env.COMFYRIZZ_HOSTED_INVITES;
    // Same host:port over the private Tailscale/LAN origin passes CSRF; the
    // missing token is then a 401, not an origin refusal.
    const owner = await request({
      method: 'PATCH', path: '/api/package/pkg_launchdemo0001', token: null,
      host: 'demo.example:4404', origin: 'http://demo.example:4404',
      body: { baseRevision: 1, package: seed },
    });
    assert.equal(owner.status, 401, owner.text);
    process.env.COMFYRIZZ_HOSTED_INVITES = '1';
    const hosted = await request({
      method: 'PATCH', path: '/api/package/pkg_launchdemo0001',
      host: 'demo.example:4404', origin: 'http://demo.example:4404',
      body: { baseRevision: 1, package: seed },
    });
    assert.equal(hosted.status, 403, hosted.text);
  } finally {
    if (savedHosts === undefined) delete process.env.COMFYRIZZ_ALLOWED_HOSTS; else process.env.COMFYRIZZ_ALLOWED_HOSTS = savedHosts;
    if (savedHosted === undefined) delete process.env.COMFYRIZZ_HOSTED_INVITES; else process.env.COMFYRIZZ_HOSTED_INVITES = savedHosted;
  }
});

test('PATCH saves, bumps revision and persists', async () => {
  const edited = app.store.read(seed.id);
  edited.scenes[0].copy.headline = 'Edited in C2';
  const saved = await request({ method: 'PATCH', path: '/api/package/pkg_launchdemo0001', body: { baseRevision: 1, package: edited } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.revision, 2);
  assert.equal(saved.json.package.scenes[0].copy.headline, 'Edited in C2');
  const reread = await request({ path: '/api/package/pkg_launchdemo0001' });
  assert.equal(reread.json.revision, 2);
  assert.equal(reread.json.package.scenes[0].copy.headline, 'Edited in C2');
  // A second stale write cannot silently overwrite the accepted edit.
  assert.equal((await request({ method: 'PATCH', path: '/api/package/pkg_launchdemo0001', body: { baseRevision: 1, package: seed } })).status, 409);
});

test('PATCH rejects an invalid package with details', async () => {
  const invalid = structuredClone(seed);
  invalid.schemaVersion = 99;
  const response = await request({ method: 'PATCH', path: '/api/package/pkg_launchdemo0001', body: { baseRevision: 2, package: invalid } });
  assert.equal(response.status, 422);
  assert.equal(response.json.error, 'invalid package');
  assert.ok(Array.isArray(response.json.details) && response.json.details.length > 0);
});

test('POST /api/render returns MP4 and records SSE events', async () => {
  const response = await request({ method: 'POST', path: '/api/render', body: { packageId: 'pkg_launchdemo0001', baseRevision: 2 } });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'video/mp4');
  assert.equal(response.text, 'fake mp4 bytes');
  assert.equal(response.headers['x-comfyrizz-frames'], '42');
  assert.equal(response.headers['x-comfyrizz-revision'], '2');
  const eventTypes = app.events.replay(0).map(event => event.type);
  assert.deepEqual(eventTypes.slice(-2), ['render.started', 'render.finished']);
  assert.equal(app.events.replay(0).at(-1).timeline_sha256, 'deadbeef');
});

test('POST /api/render rejects a stale base revision before rendering', async () => {
  const response = await request({ method: 'POST', path: '/api/render', body: { packageId: 'pkg_launchdemo0001', baseRevision: 1 } });
  assert.equal(response.status, 409);
  assert.equal(response.json.currentRevision, 2);
});

test('SSE replays from Last-Event-ID', async () => {
  app.events.publish({ type: 'test.one' });
  app.events.publish({ type: 'test.two' });
  const last = app.events.replay(0).at(-1).id;
  const text = await new Promise((resolve, reject) => {
    const req = httpGet({ hostname: '127.0.0.1', port, path: `/api/events?token=${TOKEN}&lastEventId=${last - 1}`, headers: { host: `127.0.0.1:${port}` } }, response => {
      let data = '';
      response.on('data', chunk => {
        data += chunk;
        if (data.includes('test.two')) {
          response.destroy();
          resolve(data);
        }
      });
    });
    req.on('error', error => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
  });
  assert.match(text, /event: test\.two/);
  assert.match(text, new RegExp(`id: ${last}`));
});

test('POST /api/agent runs the runner, validates and compiles the package', async () => {
  const response = await request({ method: 'POST', path: '/api/agent', body: { brief: 'a calm agent desktop', sessionId: 'agent-progress-test' } });
  assert.equal(response.status, 200);
  assert.equal(response.json.sessionId, 'agent-progress-test');
  assert.equal(response.json.package.id, 'pkg_agenttest0001');
  assert.ok(response.json.timeline.durationInFrames > 0);
  assert.deepEqual(response.json.svgAssets, ['a_icon_check']);
  assert.ok(response.json.generatedAssets.a_icon_check.svg.includes('<svg'));
  assert.equal(response.json.live, false);
  assert.equal(typeof response.json.usage.total, 'number');
  assert.equal(response.json.usage.total, response.json.usage.input + response.json.usage.output);
  const progress = await request({ path: '/api/agent/progress?sessionId=agent-progress-test' });
  assert.equal(progress.status, 200);
  assert.equal(progress.json.status, 'done');
  assert.equal(progress.json.sessionId, 'agent-progress-test');
  assert.equal(typeof progress.json.elapsedMs, 'number');
  const reread = await request({ path: '/api/package/pkg_agenttest0001' });
  assert.equal(reread.status, 200);
  assert.equal(reread.json.package.title, 'Agent: a calm agent desktop');
  assert.equal((await request({ method: 'POST', path: '/api/agent', body: {} })).status, 400);
  const eventTypes = app.events.replay(0).map(event => event.type);
  assert.ok(eventTypes.includes('agent.started') && eventTypes.includes('agent.finished'));
});

test('static path traversal is rejected', async () => {
  const response = await request({ path: '/%2e%2e/package.json', token: null, origin: null });
  assert.ok([403, 404].includes(response.status));
});
