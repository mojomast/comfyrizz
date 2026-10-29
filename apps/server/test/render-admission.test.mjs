// RL06 acceptance: the shared operation slot (RL05's coordinator) gates export, full
// render and the two scene render routes. A request takes the slot *before* its body is
// read, so a slow request holds the machine while a second one is refused with 409 and
// the holder's details; the slot is released again on every exit path (400, 409, a failed
// job, a finished response, a client that goes away). Local only: no network, no Google
// Colab runtime, no secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

const TOKEN = 'render-admission-token-0123456789abcdef';
const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));
const PACKAGE_ID = seed.id;
const REVISION = seed.revision;
const SCENE_ID = 's_title';
const REASON = 'RL06 admission test';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const FAKE_MP4 = 'fake mp4 bytes';
const FAKE_BYTES = Buffer.byteLength(FAKE_MP4);

/** A renderer that writes a small stand-in MP4 and reports it. */
function stubRender() {
  return async (packagePath, output) => {
    writeFileSync(output, FAKE_MP4);
    return { output, bytes: FAKE_BYTES, frames: 42, hash: 'rl06hash' };
  };
}

/** The incremental scene renderer, stubbed the same way. */
function stubRenderScene() {
  return async (packagePath, output) => {
    writeFileSync(output, FAKE_MP4);
    return { output, bytes: FAKE_BYTES, frames: 42, timelineHash: 'rl06hash', rendered: [], reused: [], segments: [] };
  };
}

async function setup(t, { render, renderScene } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-rl06-'));
  const app = createApp({
    root: new URL('../../..', import.meta.url).pathname,
    token: TOKEN,
    runtimeDir,
    render: render ?? stubRender(),
    renderScene: renderScene ?? stubRenderScene(),
  });
  app.store.seed(structuredClone(seed));
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { app, port };
}

function requestHeaders(port, extra = {}) {
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    'x-comfyrizz-token': TOKEN,
    'content-type': 'application/json',
    ...extra,
  };
}

function readResponse(response, chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.statusCode, headers: response.headers, text, json };
}

/** A complete request: the whole body is written at once. */
function post({ port, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent: false,
      headers: requestHeaders(port, { 'content-length': Buffer.byteLength(payload) }),
    });
    req.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(readResponse(response, chunks)));
      response.on('error', error => reject(error));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * A request whose body arrives in two parts: the headers reach the server (so the route
 * takes the shared slot) while the body is still streaming.
 */
function slowPost({ port, path, body, delayMs = 60 }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body ?? {}));
    const half = Math.floor(payload.length / 2);
    let response = null;
    const chunks = [];
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent: false,
      headers: requestHeaders(port, { 'transfer-encoding': 'chunked' }),
    });
    req.on('response', res => {
      response = res;
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(readResponse(res, chunks)));
      res.on('error', () => resolve(readResponse(res, chunks)));
    });
    req.on('error', error => {
      // A refused request may close the socket before the rest of the body is written.
      if (response) {
        resolve(readResponse(response, chunks));
        return;
      }
      reject(error);
    });
    req.write(payload.subarray(0, half));
    setTimeout(() => req.end(payload.subarray(half)), delayMs);
  });
}

test('missing narrated audio blocks final render and labels draft warnings', async t => {
  const h = await setup(t);
  const pkg = structuredClone(seed);
  pkg.voice = { enabled: true, engine: 'kokoro', voice: 'af_heart', language: 'en-us', speed: 1 };
  pkg.scenes[0].narration = 'A planned narration.';
  const final = await post({ ...h, path: '/api/render', body: { package: pkg, override: { reason: REASON } } });
  assert.equal(final.status, 409, final.text);
  assert.equal(final.json.code, 'NARRATION_PENDING');
  const draft = await post({ ...h, path: '/api/render', body: { package: pkg, intent: 'draft', override: { reason: REASON } } });
  assert.equal(draft.status, 200, draft.text);
  assert.equal(draft.headers['x-comfyrizz-export-intent'], 'draft');
  assert.match(draft.headers['x-comfyrizz-delivery-warnings'], /NARRATION_PENDING/);
});

test('RL06: two parallel requests with a slow body -> exactly one 409', async t => {
  const gate = deferred();
  const h = await setup(t, {
    render: async (packagePath, output) => {
      await gate.promise;
      writeFileSync(output, FAKE_MP4);
      return { output, bytes: FAKE_BYTES, frames: 42, hash: 'rl06hash' };
    },
  });
  const body = { packageId: PACKAGE_ID, override: { reason: REASON } };
  const first = slowPost({ ...h, path: '/api/render', body });
  // The first request owns the slot while its body is still streaming.
  await delay(40);
  const second = slowPost({ ...h, path: '/api/render', body });
  // The second request must be answered while the first one still holds the slot.
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); });
  const refused = await Promise.race([second, timeout]);
  clearTimeout(timer);
  assert.ok(refused, 'the second request is answered while the first one still holds the slot');
  assert.equal(refused.status, 409, refused.text);

  gate.resolve();
  const settled = await Promise.allSettled([first, second]);
  const results = settled.map(entry => (entry.status === 'fulfilled'
    ? entry.value
    : { status: 0, text: String(entry.reason), json: undefined }));
  const refusals = results.filter(result => result.status === 409);
  const admissions = results.filter(result => result.status !== 409);
  assert.equal(refusals.length, 1, `exactly one request is refused: ${results.map(result => result.status).join('/')}`);
  assert.equal(admissions.length, 1);
  assert.equal(refusals[0].json.error, 'render busy');
  assert.equal(refusals[0].json.busy, true);
  assert.equal(refusals[0].json.holder.kind, 'render');
  assert.match(refusals[0].json.holder.id, /^r_/);
  assert.ok(!Number.isNaN(Date.parse(refusals[0].json.holder.since)), 'the holder carries a timestamp');
  assert.equal(admissions[0].status, 200, admissions[0].text);
  assert.equal(admissions[0].text, FAKE_MP4);
});

test('RL06: an export during a scene render is refused with the holder', async t => {
  const started = deferred();
  const gate = deferred();
  const h = await setup(t, {
    renderScene: async (packagePath, output) => {
      started.resolve();
      await gate.promise;
      writeFileSync(output, FAKE_MP4);
      return { output, bytes: FAKE_BYTES, frames: 42, timelineHash: 'rl06hash', rendered: [], reused: [], segments: [] };
    },
  });
  const scene = post({ ...h, path: '/api/scene/render', body: { packageId: PACKAGE_ID, sceneId: SCENE_ID } });
  await started.promise;

  const exported = await post({ ...h, path: '/api/export', body: { packageId: PACKAGE_ID } });
  assert.equal(exported.status, 409);
  assert.equal(exported.json.error, 'export busy');
  assert.equal(exported.json.busy, true);
  assert.equal(exported.json.holder.kind, 'scene-render');
  assert.match(exported.json.holder.id, /^sr_/);

  gate.resolve();
  const rendered = await scene;
  assert.equal(rendered.status, 200, rendered.text);
});

test('RL06: a 400 releases the slot for the next request', async t => {
  const h = await setup(t);
  const rejected = await post({ ...h, path: '/api/export', body: {} });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error, 'packageId or package required');

  // The slot is free again, so the same request is not refused as busy.
  const again = await post({ ...h, path: '/api/export', body: {} });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'packageId or package required');

  // And a real operation can take the slot right away.
  const rendered = await post({ ...h, path: '/api/scene/render', body: { packageId: PACKAGE_ID, sceneId: SCENE_ID } });
  assert.equal(rendered.status, 200, rendered.text);
});

test('RL06: a failed render releases the slot', async t => {
  const h = await setup(t, {
    render: async () => { throw new Error('render deliberately failed'); },
  });
  const failed = await post({ ...h, path: '/api/render', body: { packageId: PACKAGE_ID, override: { reason: REASON } } });
  assert.equal(failed.status, 500);
  assert.match(failed.text, /render deliberately failed/);

  const next = await post({ ...h, path: '/api/scene/render', body: { packageId: PACKAGE_ID, sceneId: SCENE_ID } });
  assert.equal(next.status, 200, next.text);
});

test('RL06: a client that goes away releases the slot', async t => {
  const h = await setup(t);
  // A request that stops half way through its body: the server holds the slot while
  // it waits for the rest, and the client disappears.
  const socket = connect(h.port, '127.0.0.1', () => {
    socket.write([
      'POST /api/render HTTP/1.1',
      `Host: 127.0.0.1:${h.port}`,
      `Origin: http://127.0.0.1:${h.port}`,
      `X-Comfyrizz-Token: ${TOKEN}`,
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      '', '5', 'hello',
    ].join('\r\n'));
  });
  const closed = new Promise(resolve => socket.once('close', resolve));
  await delay(100);
  socket.destroy();
  await closed;

  // The abandoned request must not keep the slot: a real operation is admitted again.
  let rendered = await post({ ...h, path: '/api/scene/render', body: { packageId: PACKAGE_ID, sceneId: SCENE_ID } });
  const deadline = Date.now() + 2000;
  while (rendered.status === 409 && Date.now() < deadline) {
    await delay(50);
    rendered = await post({ ...h, path: '/api/scene/render', body: { packageId: PACKAGE_ID, sceneId: SCENE_ID } });
  }
  assert.equal(rendered.status, 200, rendered.text);
});

test('RL06: a pipeline start is refused while the slot is held', async t => {
  const started = deferred();
  const gate = deferred();
  const h = await setup(t, {
    render: async (packagePath, output) => {
      started.resolve();
      await gate.promise;
      writeFileSync(output, FAKE_MP4);
      return { output, bytes: FAKE_BYTES, frames: 42, hash: 'rl06hash' };
    },
  });
  const rendering = post({ ...h, path: '/api/render', body: { packageId: PACKAGE_ID, override: { reason: REASON } } });
  await started.promise;

  const pipeline = await post({
    ...h,
    path: '/api/pipeline',
    body: { packageId: PACKAGE_ID, baseRevision: REVISION, override: { reason: REASON } },
  });
  assert.equal(pipeline.status, 409);
  assert.equal(pipeline.json.error, 'pipeline busy');

  gate.resolve();
  assert.equal((await rendering).status, 200);
});
