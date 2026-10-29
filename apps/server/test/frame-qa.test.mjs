import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { runFrameQa, createQaRegistry } from '../src/qa.mjs';

const TOKEN = 'test-token-0123456789abcdef';

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function makeClip(dir) {
  const mp4 = join(dir, 'clip.mp4');
  ffmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=0xdddddd:s=64x36:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-y', mp4]);
  return mp4;
}

function timeline() {
  return { fps: 30, width: 1920, height: 1080, durationInFrames: 60, scenes: [{ id: 's_a', layout: 'title', variant: 'centered', from: 0, durationInFrames: 60, transitionInFrames: 0, transitionOutFrames: 0 }] };
}

test('runFrameQa writes a qa.json sidecar and a contact sheet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-qa-lib-'));
  try {
    const result = runFrameQa({ mp4: makeClip(dir), timeline: timeline(), outDir: dir, pkg: { theme: { palette: ['#dddddd', '#dddddd', '#dddddd'] } } });
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.findings));
    assert.ok(existsSync(result.qaPath));
    assert.ok(result.sheet && existsSync(result.sheet));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createQaRegistry keeps the latest result per render and per package', () => {
  const registry = createQaRegistry();
  registry.record('r_1', 'pkg_a', { ok: true });
  registry.record('r_2', 'pkg_a', { ok: false });
  assert.equal(registry.lookup({ renderId: 'r_1' }).ok, true);
  assert.equal(registry.lookup({ packageId: 'pkg_a' }).ok, false);
  assert.equal(registry.lookup({ renderId: 'nope' }), null);
});

test('the render path runs the QA gate and serves it from /api/qa', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-qa-app-'));
  const premade = makeClip(runtime);
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    render: async (packagePath, output) => {
      copyFileSync(premade, output);
      return { output, bytes: statSync(output).size, frames: 60, hash: 'qa', timeline: timeline() };
    },
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../renderer/test/fixtures/tiny/package.json', import.meta.url), 'utf8'));
    const invalid = await request({ port, method: 'POST', path: '/api/render', body: { package: { id: 'pkg_qatest0001', revision: 1 } } });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
    assert.equal(invalid.json.code, 'INVALID_PACKAGE');
    const response = await request({ port, method: 'POST', path: '/api/render', body: { package: pkg, intent: 'draft' } });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const renderId = response.headers['x-comfyrizz-render-id'];
    assert.ok(renderId);
    const qa = await request({ port, method: 'GET', path: `/api/qa?renderId=${renderId}` });
    assert.equal(qa.status, 200);
    assert.equal(qa.json.ok, true);
    assert.ok(Array.isArray(qa.json.findings));
    assert.ok(existsSync(join(runtime, 'renders', `${renderId}.qa.json`)));
    const sheet = await request({ port, method: 'GET', path: `/api/qa/sheet?renderId=${renderId}` });
    assert.equal(sheet.status, 200);
    assert.equal(sheet.headers['content-type'], 'image/png');
  } finally {
    app.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtime, { recursive: true, force: true });
  }
});

function request({ port, method = 'GET', path = '/', token = TOKEN, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'x-comfyrizz-token': token, origin: `http://127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, headers: response.headers, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
