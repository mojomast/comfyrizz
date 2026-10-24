// The local render worker: export, full render, scene render and edited render
// load a renderer module inside the worker. Cancel kills the child process tree
// and the shared slot stays taken until that child exits. A worker that exits
// without a result fails the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { createApp } from '../src/app.mjs';
import { spawnCancellable } from '../../renderer/scripts/cancellable-spawn.mjs';

const TOKEN = 'render-worker-token-0123456789abcdef';
const repo = new URL('../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));
const FIXTURE = new URL('./fixtures/fake-worker-renderer.mjs', import.meta.url);
const REASON = 'worker path test';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(read, ms = 4000) {
  const start = Date.now();
  let value = read();
  while (!value && Date.now() - start < ms) {
    await delay(20);
    value = read();
  }
  if (!value) throw new Error('timed out waiting for the render child');
  return value;
}

function killPid(file) {
  try {
    const pid = Number(readFileSync(file, 'utf8'));
    if (!pid) return;
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the group has already exited */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* the process has already exited */ }
  } catch { /* no pid file yet */ }
}

function writeRenderer({ dir, mode = 'render', termMs = 1500, hold = false }) {
  const logFile = join(dir, 'renderer.log');
  const pidFile = join(dir, 'child.pid');
  const grandFile = join(dir, 'grand.pid');
  const holdFile = join(dir, 'hold');
  const file = join(dir, 'renderer.mjs');
  writeFileSync(logFile, '');
  if (hold) writeFileSync(holdFile, '1');
  const fixture = FIXTURE.href;
  writeFileSync(file, `
import { run } from ${JSON.stringify(fixture)};
const paths = ${JSON.stringify({ logFile, pidFile, grandFile, termMs, holdFile })};
async function render(kind, packagePath, outputPath, options) {
  if (${JSON.stringify(mode)} === 'exit') process.exit(0);
  if (${JSON.stringify(mode)} === 'fail') throw new Error('render deliberately failed');
  return run(kind, packagePath, outputPath, options, paths);
}
export function renderPackageAsync(packagePath, outputPath, options) {
  return render('package', packagePath, outputPath, options);
}
export function renderPackageIncrementalAsync(packagePath, outputPath, options) {
  return render('scene', packagePath, outputPath, options);
}
`);
  return { file, logFile, pidFile, grandFile, holdFile };
}

function readLog(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function boot(t, { mode = 'render', termMs = 1500, hold = false } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-render-worker-'));
  const renderer = writeRenderer({ dir: runtimeDir, mode, termMs, hold });
  mkdirSync(join(runtimeDir, 'packages'), { recursive: true });
  cpSync(join(repo, 'examples', 'launch-demo', 'assets'), join(runtimeDir, 'packages', 'assets'), { recursive: true });
  const moduleUrl = pathToFileURL(renderer.file).href;
  const app = createApp({
    root: repo,
    token: TOKEN,
    runtimeDir,
    renderModuleUrl: moduleUrl,
    sceneModuleUrl: moduleUrl,
  });
  app.store.seed(structuredClone(seed));
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    killPid(renderer.pidFile);
    killPid(renderer.grandFile);
    app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { app, port, runtimeDir, ...renderer };
}

function post({ port, path, body, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent: false,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        'x-comfyrizz-token': TOKEN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`request timed out: ${path}`));
    }, timeoutMs);
    req.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
      response.on('error', error => { clearTimeout(timer); reject(error); });
    });
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(payload);
  });
}

function startPost({ port, path, body }) {
  const payload = JSON.stringify(body ?? {});
  const req = httpRequest({
    hostname: '127.0.0.1',
    port,
    path,
    method: 'POST',
    agent: false,
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'x-comfyrizz-token': TOKEN,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
  });
  req.on('error', () => {});
  req.end(payload);
  return req;
}

function eventsOf(app, type) {
  return app.events.entries.filter(entry => entry.type === type);
}

test('spawnCancellable kills the child and its grandchild, then settles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-spawn-'));
  const pidFile = join(dir, 'child.pid');
  const grandFile = join(dir, 'grand.pid');
  const script = `
    const fs = require('fs');
    const { spawn } = require('child_process');
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));
    fs.writeFileSync(process.env.PID, String(process.pid));
    const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.GRAND, String(grand.pid));
    setInterval(() => {}, 1000);
  `;
  const abort = new AbortController();
  const pending = spawnCancellable(process.execPath, ['-e', script], {
    signal: abort.signal,
    env: { ...process.env, PID: pidFile, GRAND: grandFile },
  });
  const childPid = Number(await waitFor(() => {
    try { return readFileSync(pidFile, 'utf8'); } catch { return ''; }
  }));
  const grandPid = Number(await waitFor(() => {
    try { return readFileSync(grandFile, 'utf8'); } catch { return ''; }
  }));
  assert.equal(alive(childPid), true);
  assert.equal(alive(grandPid), true);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  abort.abort();
  await delay(50);
  assert.equal(alive(grandPid), false);
  assert.equal(settled, false, 'the spawn promise waits until the child exits');
  await assert.rejects(pending, error => error.code === 'RENDER_CANCELLED');
  assert.equal(alive(childPid), false);
  assert.equal(settled, true);
  rmSync(dir, { recursive: true, force: true });
});

test('export, render, scene render and edited render run the module inside the worker', async t => {
  const ctx = await boot(t, { termMs: 50 });
  const rendered = await post({
    port: ctx.port,
    path: '/api/render',
    body: { packageId: seed.id, override: { reason: REASON } },
  });
  assert.equal(rendered.status, 200, rendered.text);
  assert.equal(rendered.text, 'fake-mp4');

  const exported = await post({
    port: ctx.port,
    path: '/api/export',
    body: { packageId: seed.id, force: true },
  });
  assert.equal(exported.status, 200, exported.text);
  assert.equal(exported.json.packageId, seed.id);

  const scene = await post({
    port: ctx.port,
    path: '/api/scene/render',
    body: { packageId: seed.id, sceneId: 's_title' },
  });
  assert.equal(scene.status, 200, scene.text);

  const edited = await post({
    port: ctx.port,
    path: '/api/render/edited',
    body: { packageId: seed.id },
  });
  assert.equal(edited.status, 200, edited.text);

  const log = readLog(ctx.logFile);
  assert.ok(log.length >= 4, `expected four worker renders, got ${JSON.stringify(log)}`);
  assert.ok(log.every(entry => entry.main === false), JSON.stringify(log));
  assert.equal(log.filter(entry => entry.kind === 'package' && entry.final === true).length >= 1, true);
  assert.ok(log.some(entry => entry.kind === 'scene'));
  assert.equal(eventsOf(ctx.app, 'render.finished').length, 1);
  assert.equal(eventsOf(ctx.app, 'export.finished').length, 1);
  assert.equal(eventsOf(ctx.app, 'scene.render.finished').length, 1);
  assert.equal(eventsOf(ctx.app, 'edit.render.finished').length, 1);
});

test('cancel kills the render tree, emits render.cancelled, and frees the slot only after exit', async t => {
  const ctx = await boot(t, { termMs: 3000, hold: true });
  const req = startPost({
    port: ctx.port,
    path: '/api/render',
    body: { packageId: seed.id, override: { reason: REASON } },
  });
  const childPid = Number(await waitFor(() => {
    try { return readFileSync(ctx.pidFile, 'utf8'); } catch { return ''; }
  }));
  const grandPid = Number(await waitFor(() => {
    try { return readFileSync(ctx.grandFile, 'utf8'); } catch { return ''; }
  }));
  req.destroy();
  await delay(100);
  assert.equal(alive(grandPid), false, 'the grandchild is killed with the child group');
  assert.equal(alive(childPid), true, 'the child is still exiting');
  const refused = await post({
    port: ctx.port,
    path: '/api/scene/render',
    body: { packageId: seed.id, sceneId: 's_title' },
    timeoutMs: 2000,
  });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.busy, true);
  assert.equal(alive(childPid), true, 'the slot stays taken until the child exits');
  // The running child already read the hold flag. Later requests must be able to finish.
  rmSync(ctx.holdFile, { force: true });
  await delay(3200);
  assert.equal(alive(childPid), false);
  const orphans = readdirSync(ctx.app.rendersDir).filter(name => name.endsWith('.mp4') || name.endsWith('.props.json'));
  assert.deepEqual(orphans, []);
  const next = await post({
    port: ctx.port,
    path: '/api/scene/render',
    body: { packageId: seed.id, sceneId: 's_title' },
  });
  assert.equal(next.status, 200, next.text);
  assert.equal(eventsOf(ctx.app, 'render.cancelled').length, 1);
  assert.equal(eventsOf(ctx.app, 'render.failed').length, 0);
});

test('a cancelled export emits export.cancelled and holds the slot until the child exits', async t => {
  const ctx = await boot(t, { termMs: 3000, hold: true });
  const req = startPost({
    port: ctx.port,
    path: '/api/export',
    body: { packageId: seed.id, force: true },
  });
  const childPid = Number(await waitFor(() => {
    try { return readFileSync(ctx.pidFile, 'utf8'); } catch { return ''; }
  }));
  req.destroy();
  await delay(100);
  assert.equal(alive(childPid), true);
  const refused = await post({
    port: ctx.port,
    path: '/api/render',
    body: { packageId: seed.id, override: { reason: REASON } },
    timeoutMs: 2000,
  });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(alive(childPid), true, 'the slot stays taken until the child exits');
  rmSync(ctx.holdFile, { force: true });
  await delay(3200);
  assert.equal(alive(childPid), false);
  assert.equal(existsSync(join(ctx.runtimeDir, 'out', 'export', seed.id, 'video.props.json')), false);
  const next = await post({
    port: ctx.port,
    path: '/api/render',
    body: { packageId: seed.id, override: { reason: REASON } },
  });
  assert.equal(next.status, 200, next.text);
  assert.equal(eventsOf(ctx.app, 'export.cancelled').length, 1);
  assert.equal(eventsOf(ctx.app, 'export.failed').length, 0);
});

test('a worker that exits without a result fails the request', async t => {
  const ctx = await boot(t, { mode: 'exit' });
  const failed = await post({ port: ctx.port, path: '/api/render', body: { packageId: seed.id, override: { reason: REASON } } });
  assert.equal(failed.status, 500, failed.text);
  assert.match(failed.text, /without a result/);
  assert.equal(eventsOf(ctx.app, 'render.failed').length, 1);
  const next = await post({
    port: ctx.port,
    path: '/api/scene/render',
    body: { packageId: seed.id, sceneId: 's_title' },
  });
  assert.equal(next.status, 500, next.text);
  assert.match(next.text, /without a result/);
});

test('a renderer failure emits render.failed and frees the slot', async t => {
  const ctx = await boot(t, { mode: 'fail' });
  const failed = await post({ port: ctx.port, path: '/api/render', body: { packageId: seed.id, override: { reason: REASON } } });
  assert.equal(failed.status, 500, failed.text);
  assert.match(failed.text, /render deliberately failed/);
  assert.equal(eventsOf(ctx.app, 'render.failed').length, 1);
  assert.equal(eventsOf(ctx.app, 'render.cancelled').length, 0);
  const next = await post({
    port: ctx.port,
    path: '/api/scene/render',
    body: { packageId: seed.id, sceneId: 's_title' },
  });
  assert.equal(next.status, 500);
  assert.match(next.text, /render deliberately failed/);
});

test('a render function named renderPackage still runs on the server thread', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-inline-render-'));
  const marker = join(runtimeDir, 'where.txt');
  async function renderPackage(packagePath, outputPath) {
    writeFileSync(marker, isMainThread ? 'main' : 'worker');
    writeFileSync(outputPath, 'inline');
    return { output: outputPath, bytes: 6, frames: 1, hash: 'h' };
  }
  const app = createApp({
    root: repo,
    token: TOKEN,
    runtimeDir,
    render: renderPackage,
    renderScene: renderPackage,
  });
  app.store.seed(structuredClone(seed));
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const rendered = await post({
    port: server.address().port,
    path: '/api/render',
    body: { packageId: seed.id, override: { reason: REASON } },
  });
  assert.equal(rendered.status, 200, rendered.text);
  assert.equal(readFileSync(marker, 'utf8'), 'main');
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForTcp(port, ms = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connectTcp(port, '127.0.0.1');
      const fail = () => {
        socket.destroy();
        if (Date.now() - start > ms) reject(new Error(`server did not listen on ${port}`));
        else setTimeout(attempt, 40);
      };
      socket.once('connect', () => { socket.end(); resolve(); });
      socket.once('error', fail);
    };
    attempt();
  });
}

test('SIGTERM during a render kills the process tree, removes props, and exits 0', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-shutdown-'));
  const renderer = writeRenderer({ dir, termMs: 10000, hold: true });
  const runtimeDir = join(dir, 'runtime');
  const port = await freePort();
  const indexPath = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  let stderr = '';
  const server = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      COMFYRIZZ_PORT: String(port),
      COMFYRIZZ_RUNTIME: runtimeDir,
      COMFYRIZZ_TOKEN: TOKEN,
      COMFYRIZZ_DEMO: 'launch',
      COMFYRIZZ_RENDER_MODULE: renderer.file,
      COMFYRIZZ_SCENE_MODULE: renderer.file,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString()}`.slice(-4000); });
  const exitCode = new Promise(resolve => server.once('exit', code => resolve(code)));
  t.after(() => {
    killPid(renderer.pidFile);
    killPid(renderer.grandFile);
    if (server.exitCode == null) server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  try {
    await waitForTcp(port);
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  }
  startPost({
    port,
    path: '/api/render',
    body: { packageId: seed.id, override: { reason: REASON } },
  });
  const childPid = Number(await waitFor(() => {
    try { return readFileSync(renderer.pidFile, 'utf8'); } catch { return ''; }
  }, 8000));
  const grandPid = Number(await waitFor(() => {
    try { return readFileSync(renderer.grandFile, 'utf8'); } catch { return ''; }
  }));
  const rendersDir = join(runtimeDir, 'renders');
  const propsBefore = readdirSync(rendersDir).filter(name => name.endsWith('.props.json'));
  assert.equal(propsBefore.length, 1, propsBefore.join(','));
  assert.equal(alive(childPid), true);
  assert.equal(alive(grandPid), true);
  const started = Date.now();
  server.kill('SIGTERM');
  const code = await Promise.race([
    exitCode,
    (async () => {
      await delay(8000);
      throw new Error(`server did not exit\n${stderr}`);
    })(),
  ]);
  const elapsed = Date.now() - started;
  assert.equal(code, 0, stderr);
  assert.ok(elapsed < 7000, `shutdown took ${elapsed}ms`);
  assert.equal(alive(childPid), false, 'the render child is killed before the server exits');
  assert.equal(alive(grandPid), false, 'the grandchild is killed with the render group');
  const left = readdirSync(rendersDir).filter(name => name.endsWith('.props.json') || name.endsWith('.mp4'));
  assert.deepEqual(left, []);
});
