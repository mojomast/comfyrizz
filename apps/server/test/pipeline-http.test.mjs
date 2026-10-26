import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

test('pipeline HTTP contract: revisions, responsive status, durable replay, protected seekable artifacts', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'pipeline-http-'));
  let receive, finish, spec;
  const token = 'pipeline-test-token-123456789';
  const app = createApp({ token, runtimeDir, pipelineLaunch: (file, onMessage, onExit) => {
    spec = JSON.parse(readFileSync(file)); receive = onMessage; finish = onExit;
    return { cancel() {} };
  } });
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url)));
  pkg.scenes = [pkg.scenes[0]]; delete pkg.scenes[0].transitionOut;
  pkg.scenes[0].background = null; pkg.scenes[0].foreground = []; pkg.assets = {};
  app.store.seed(pkg);
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); rmSync(runtimeDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, headers = {}) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { origin: base, 'x-comfyrizz-token': token, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const body = { packageId: pkg.id, baseRevision: pkg.revision, backendId: 'cpu' };
  const diagnostics = await (await request('/api/pipeline/diagnostics')).json();
  assert.equal(typeof diagnostics.syncnet.configured, 'boolean');
  if (diagnostics.syncnet.configured === false) {
    assert.equal(diagnostics.syncnet.code, 'SYNCNET_UNAVAILABLE');
    assert.match(diagnostics.syncnet.message, /SyncNet is not configured/);
  } else {
    assert.equal(diagnostics.syncnet.code, undefined);
  }
  assert.equal((await request('/api/pipeline', { ...body, baseRevision: 999 })).status, 409);
  const plan = await (await request('/api/pipeline/plan', body)).json(); assert.equal(plan.ready, true);
  const start = await request('/api/pipeline', body); assert.equal(start.status, 202);
  const { run } = await start.json(), path = `/api/pipeline/${run.runId}`;
  assert.equal((await request('/api/pipeline', body)).status, 409);
  assert.equal((await request('/api/render', body)).status, 409);
  assert.equal((await request(path + '/files/video.mp4')).status, 404);
  const snapshot = await (await request(path)).json(); assert.equal(snapshot.run.status, 'running');
  receive({ kind: 'progress', stageId: 'render', progress: { completed: 1, total: 30, unit: 'frames', mode: 'measured' } });
  const replay = await (await request(path + '/events?after=1')).json(); assert.equal(replay.events[0].kind, 'progress');
  // Edits accepted while the immutable cut is running must never be replaced by its result.
  app.store.save(pkg.id, { ...pkg, title: 'A newer user edit' }, pkg.revision);
  const target = join(spec.runDir, 'exports', pkg.id); mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'video.mp4'), Buffer.from('0123456789'));
  for (const stage of plan.stages) receive({ kind: 'stage', stageId: stage.id, status: 'completed' });
  receive({ kind: 'result', result: { files: [{ name: 'video.mp4', bytes: 10 }] } }); finish(0);
  assert.equal(app.store.read(pkg.id).title, 'A newer user edit');
  const media = await request(path + '/files/video.mp4', null, { range: 'bytes=2-5' });
  assert.equal(media.status, 206); assert.equal(await media.text(), '2345');
  assert.equal((await fetch(base + path + '/files/video.mp4')).status, 401);
  assert.equal((await request(path + '/files/state.json')).status, 404);
  const outside = join(runtimeDir, 'outside-export.mp4');
  writeFileSync(outside, 'not an exported artifact');
  rmSync(join(target, 'video.mp4'));
  symlinkSync(outside, join(target, 'video.mp4'));
  assert.equal((await request(path + '/files/video.mp4')).status, 404, 'manifest file symlink cannot escape export root');
  rmSync(target, { recursive: true });
  const outsideDir = join(runtimeDir, 'outside-exports');
  mkdirSync(outsideDir); writeFileSync(join(outsideDir, 'video.mp4'), 'outside run');
  symlinkSync(outsideDir, target, 'dir');
  assert.equal((await request(path + '/files/video.mp4')).status, 404, 'export directory symlink cannot escape run');
});
