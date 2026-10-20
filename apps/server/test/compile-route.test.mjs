import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { compileTimeline, frameProjection, measuredFromReport } from '../../../packages/planner/dist/src/browser.js';

const TOKEN = 'test-token-0123456789abcdef';
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../web/test/fixtures/editor/${name}`, import.meta.url), 'utf8'));
let runtime;
let app;
let server;
let port;

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-compile-'));
  app = createApp({
    root: new URL('../../..', import.meta.url).pathname,
    token: TOKEN,
    runtimeDir: runtime,
    render: async () => ({ output: '', bytes: 0, frames: 1, hash: 'abc' }),
  });
  server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  app.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(runtime, { recursive: true, force: true });
});

function request({ method = 'GET', path = '/', token = TOKEN, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        ...(token ? { 'x-comfyrizz-token': token } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buffer.toString('utf8')); } catch { json = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, json, buffer });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('compile requires the session token', async () => {
  const denied = await request({ method: 'POST', path: '/api/compile', token: null, body: { package: fixture('short.json') } });
  assert.equal(denied.status, 401);
});

test('compile echoes revision, edit sequence and input hash and matches the browser', async () => {
  const pkg = fixture('short.json');
  const measured = measuredFromReport(fixture('narration-durations.json'));
  const local = compileTimeline({ package: fixture('narration.json'), editor: { version: 1, captionOverrides: [] }, editSequence: 4 }, measured);
  const response = await request({
    method: 'POST',
    path: '/api/compile',
    body: { doc: { package: fixture('narration.json'), editor: { version: 1, captionOverrides: [] }, editSequence: 4 }, measured, revision: 3, editSequence: 4 },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.revision, 3);
  assert.equal(response.json.editSequence, 4);
  assert.equal(typeof response.json.inputHash, 'string');
  assert.equal(response.json.inputHash.length, 64);
  assert.deepEqual(frameProjection(response.json.timeline), frameProjection(local));
  const silent = await request({ method: 'POST', path: '/api/compile', body: { package: pkg, revision: 1, editSequence: 1 } });
  assert.equal(silent.json.timeline.durationInFrames, 420);
});

test('save acknowledges its edit sequence and stores the editor sidecar', async () => {
  const pkg = structuredClone(fixture('short.json'));
  pkg.schemaVersion = 1;
  pkg.revision = 1;
  pkg.createdAt = '2026-10-19T00:00:00.000Z';
  pkg.assets = {};
  pkg.compliance = { open_weights_only: true, backends_used: [] };
  pkg.theme = { palette: ['#0d0f14', '#6d8cff'], font: 'Inter' };
  // The short fixture is a compile fixture, not a schema package. Seed the launch demo and patch copy.
  const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));
  app.store.seed(seed);
  const edited = structuredClone(seed);
  edited.scenes[0].copy.headline = 'Saved from the editor';
  const editor = { version: 1, captionOverrides: [{ sceneId: edited.scenes[0].id, index: 0, text: 'On screen' }] };
  const saved = await request({
    method: 'PATCH',
    path: `/api/package/${seed.id}`,
    body: { baseRevision: seed.revision, package: edited, editor, editSequence: 6 },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.revision, seed.revision + 1);
  assert.equal(saved.json.editSequence, 6);
  assert.equal(saved.json.editor.captionOverrides[0].text, 'On screen');
  const again = await request({ path: `/api/package/${seed.id}` });
  assert.equal(again.json.editor.captionOverrides[0].text, 'On screen');
  assert.equal(again.json.package.scenes[0].copy.headline, 'Saved from the editor');
  // A preference below layout.min is schema-valid (minimum 1). The compiler floors it; the server stores it.
  const floored = structuredClone(again.json.package);
  floored.scenes[0].preferredFrames = 5;
  const trimmed = await request({
    method: 'PATCH',
    path: `/api/package/${seed.id}`,
    body: {
      baseRevision: again.json.revision,
      package: floored,
      editor: { version: 1, captionOverrides: [] },
      editSequence: 7,
    },
  });
  assert.equal(trimmed.status, 200, JSON.stringify(trimmed.json));
  assert.equal(trimmed.json.package.scenes[0].preferredFrames, 5);
  assert.equal(trimmed.json.editSequence, 7);
});

test('package media is served with byte ranges and rejects traversal', async () => {
  const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));
  const root = join(runtime, 'media', seed.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'clip.mp4'), Buffer.from('0123456789'));
  const ok = await request({ path: `/api/package/${seed.id}/media?path=clip.mp4`, headers: { range: 'bytes=0-3' } });
  assert.equal(ok.status, 206);
  assert.equal(ok.buffer.toString('utf8'), '0123');
  assert.match(String(ok.headers['content-range']), /bytes 0-3\/10/);
  const escaped = await request({ path: `/api/package/${seed.id}/media?path=../clip.mp4` });
  assert.equal(escaped.status, 400);
  const queryToken = await request({ path: `/api/package/${seed.id}/media?path=clip.mp4&token=${TOKEN}`, token: null });
  assert.equal(queryToken.status, 200);
});
