// C8 acceptance: a live brief through a *second* OpenAI-compatible provider
// goes app -> /api/agent -> the M2 edit loop -> /api/render -> a real CPU MP4
// checked with ffprobe. The provider is a loopback fake that replays the same
// agent calls over the real SSE transport, so there is no network and no key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { defaultCpuScript } from '../../../packages/agent/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { replayProvider } from './fake-provider.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const BRIEF =
  'Icon, diagram, dots, bars; nebula launch.';

let runtime;
let app;
let server;
let port;
let provider;
const state = { packageId: null, revision: null, frames: null };

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-c8-'));
  provider = await replayProvider(defaultCpuScript(BRIEF).map(call => ({ name: call.name, args: call.args })), {
    svgText: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#f2f2f2"/><text x="10" y="60" fill="#050505">Launch</text></svg>',
  });
  app = createApp({
    root: new URL('../../..', import.meta.url).pathname,
    token: TOKEN,
    runtimeDir: runtime,
    agentRunner: createCpuAgentRunner({
      runtimeDir: runtime,
      providers: { custom: { baseUrl: provider.url } },
    }),
  });
  server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  app.close();
  await new Promise(resolve => server.close(resolve));
  await provider.close();
  rmSync(runtime, { recursive: true, force: true });
});

function request({ method = 'GET', path = '/', token = TOKEN, origin = `http://127.0.0.1:${port}`, host = `127.0.0.1:${port}`, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host, origin };
    if (token) headers['x-comfyrizz-token'] = token;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers });
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

function binaryRequest({ method = 'GET', path = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'x-comfyrizz-token': TOKEN };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers });
    req.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('a live brief on a second provider builds a valid package', { timeout: 120_000 }, async () => {
  const response = await request({ method: 'POST', path: '/api/agent', body: { brief: BRIEF, provider: 'custom', model: 'deepseek-v4.1-flash' } });
  assert.equal(response.status, 200, response.text.slice(0, 500));
  assert.equal(response.json.live, true);
  assert.equal(response.json.fallback, false);
  assert.equal(response.json.provider, 'custom');
  assert.ok(response.json.svgAssets.length >= 4, `expected >=4 SVG assets, got ${response.json.svgAssets.length}`);
  assert.ok(response.json.pendingGpu.length >= 1, 'expected at least one pending-GPU plan');
  assert.ok(response.json.timeline.durationInFrames > 0);
  assert.equal(validatePackage(response.json.package).valid, true);
  state.packageId = response.json.package.id;
  state.revision = response.json.revision;
  state.frames = response.json.timeline.durationInFrames;
});

test('M2 edit loop persists a headline + chart value with a base revision', { timeout: 30_000 }, async () => {
  const got = await request({ path: `/api/package/${state.packageId}` });
  assert.equal(got.status, 200);
  const pkg = got.json.package;
  pkg.scenes.find(scene => scene.id === 's_title').copy.headline = 'Edited headline C8';
  pkg.datasets.d_minutes.values[0].value = 99;

  const stale = await request({
    method: 'PATCH',
    path: `/api/package/${state.packageId}`,
    body: { baseRevision: got.json.revision + 5, package: pkg },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.currentRevision, got.json.revision);

  const saved = await request({
    method: 'PATCH',
    path: `/api/package/${state.packageId}`,
    body: { baseRevision: got.json.revision, package: pkg },
  });
  assert.equal(saved.status, 200, saved.text.slice(0, 500));
  assert.equal(saved.json.revision, got.json.revision + 1);
  assert.equal(saved.json.package.scenes.find(scene => scene.id === 's_title').copy.headline, 'Edited headline C8');
  assert.equal(saved.json.package.datasets.d_minutes.values[0].value, 99);
  state.revision = saved.json.revision;
});

test('export renders the edited revision to a real CPU MP4', { timeout: 900_000 }, async () => {
  const pkg = app.store.read(state.packageId);
  collectMockContribution(pkg, app.store.dir);
  app.store.write(pkg);
  state.revision = app.store.read(state.packageId).revision;
  const response = await binaryRequest({ method: 'POST', path: '/api/render', body: { packageId: state.packageId, baseRevision: state.revision, override: { reason: 'CPU acceptance test uses a planned GPU placeholder' } } });
  assert.equal(response.status, 200, response.buffer.toString('utf8').slice(0, 500));
  assert.equal(response.headers['content-type'], 'video/mp4');
  assert.equal(Number(response.headers['x-comfyrizz-revision']), state.revision);
  assert.equal(Number(response.headers['x-comfyrizz-frames']), state.frames);
  assert.ok(response.buffer.length > 100_000, `expected a real MP4, got ${response.buffer.length} bytes`);

  const output = join(runtime, 'c8-render.mp4');
  writeFileSync(output, response.buffer);
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,width,height,nb_frames',
      '-show_entries', 'format=duration',
      '-of', 'json',
      output,
    ]).toString(),
  );
  const video = probe.streams.find(stream => stream.codec_name === 'h264');
  assert.ok(video, 'ffprobe should report an H.264 video stream');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.equal(Number(video.nb_frames), state.frames);
  assert.ok(Number(probe.format.duration) > 0, 'expected a non-zero duration');
});
