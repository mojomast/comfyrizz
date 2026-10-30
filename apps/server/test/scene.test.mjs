// C11 acceptance: per-scene re-run from the storyboard.
//
// 1. A scene re-render goes through the renderer's incremental renderer (A6): the segments of
//    untouched scenes are reused from cache (their files' mtimes do not change) and the output
//    still has the full compiled frame count. The frame source is stubbed with ffmpeg so the test
//    needs no browser; the cache keys, reuse decision, concat and ffprobe are the real ones.
// 2. The "Regenerate media" plan for one scene contains only that scene's jobs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { sceneAssetIds } from '../src/scene.mjs';
import { renderPackageIncremental } from '../../renderer/scripts/render-incremental.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const TINY = join(here, '..', '..', 'renderer', 'test', 'fixtures', 'tiny');
const SHOWCASE = join(here, '..', '..', '..', 'examples', 'showcase-gpu3', 'package.json');
const TOKEN = 'c11-token-0123456789abcdef';

/** A real, concat-able H.264 clip with exactly `segment.frames` frames. */
function stubSegment(segment, segmentPath) {
  const seconds = (segment.frames / 30).toFixed(6);
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=640x360:r=30:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', segmentPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`stub segment failed: ${result.stderr}`);
}

test('a one-scene re-render reuses every other scene segment and keeps the frame count', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-c11-'));
  scratch.push(runtime);
  // The server's package dir is <runtime>/packages; the fixture's SVG assets sit next to it.
  cpSync(join(TINY, 'assets'), join(runtime, 'packages', 'assets'), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(TINY, 'package.json'), 'utf8'));
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    renderScene: (packagePath, outputPath, options) => renderPackageIncremental(packagePath, outputPath, { ...options, renderSegment: stubSegment }),
  });
  app.store.write(pkg);
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const first = await postSceneRender(server, { packageId: pkg.id, sceneId: 's_title', intent: 'draft' });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const timeline = compileTimeline(pkg);
    assert.equal(Number(first.headers['x-comfyrizz-frames']), timeline.durationInFrames);
    const firstFinish = lastEvent(app, 'scene.render.finished');
    assert.equal(firstFinish.rendered.length, timeline.scenes.length, 'the first run renders every segment');

    const mtimes = new Map(firstFinish.rendered.concat(firstFinish.reused).map((key) => [key, statSync(join(app.sceneCacheDir(pkg.id), `${key}.mp4`)).mtimeMs]));
    const outroKey = firstFinish.rendered[firstFinish.rendered.length - 1];
    const statKey = firstFinish.rendered[1];

    // Edit only the first scene, save, then ask the server to re-render that scene.
    const edited = structuredClone(pkg);
    edited.scenes[0].copy.headline = 'Edited headline';
    app.store.save(pkg.id, edited, pkg.revision);

    // Verify the output MP4 really has the full frame count.
    const second = await postSceneRender(server, { packageId: pkg.id, sceneId: 's_title', intent: 'draft' });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    const output = join(runtime, 'scene.mp4');
    writeFileSync(output, second.body);
    assert.equal(ffprobeFrames(output), timeline.durationInFrames, 'the re-render still has the full frame count');
    const secondFinish = lastEvent(app, 'scene.render.finished');
    assert.equal(secondFinish.rendered.length, 1, 'only the edited scene segment re-renders');
    assert.ok(!secondFinish.reused.includes(firstFinish.rendered[0]), 'the edited scene old segment is not reused');
    assert.ok(secondFinish.reused.includes(statKey), 'the untouched middle segment is reused');
    assert.ok(secondFinish.reused.includes(outroKey), 'the untouched outro segment is reused');
    assert.equal(secondFinish.rendered.length + secondFinish.reused.length, timeline.scenes.length);
    assert.equal(statSync(join(app.sceneCacheDir(pkg.id), `${statKey}.mp4`)).mtimeMs, mtimes.get(statKey), 'the untouched segment file was not rewritten');
    assert.equal(statSync(join(app.sceneCacheDir(pkg.id), `${outroKey}.mp4`)).mtimeMs, mtimes.get(outroKey), 'the outro segment file was not rewritten');
  } finally {
    app.close();
    await new Promise((done) => server.close(done));
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('the one-scene plan contains only that scene jobs, as a dry run', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-c11-plan-'));
  scratch.push(runtime);
  const pkg = JSON.parse(readFileSync(SHOWCASE, 'utf8'));
  const app = createApp({ token: TOKEN, runtimeDir: runtime, render: async () => ({ output: 'x', bytes: 0, frames: 0, hash: 'x' }) });
  app.store.write(pkg);
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const sceneId = 's_flow';
    const expectedAssets = sceneAssetIds(pkg, sceneId);
    const response = await postScenePlan(server, { packageId: pkg.id, sceneId });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.dryRun, true);
    assert.equal(response.json.metered, false);
    assert.deepEqual([...response.json.assets].sort(), expectedAssets);
    assert.ok(response.json.jobs > 0, 'the scene has jobs to plan');
    for (const job of response.json.jobsDoc.jobs) {
      assert.ok(expectedAssets.includes(job.asset), `job ${job.id} references ${job.asset}, not a ${sceneId} asset`);
      assert.equal(job.scene, sceneId, `job ${job.id} belongs to ${job.scene}`);
    }
    // A scene with no generated assets plans nothing; an unknown scene is a 404.
    const empty = await postScenePlan(server, { packageId: pkg.id, sceneId: 's_title' });
    assert.equal(empty.status, 200);
    const unknown = await postScenePlan(server, { packageId: pkg.id, sceneId: 'nope' });
    assert.equal(unknown.status, 404);
  } finally {
    app.close();
    await new Promise((done) => server.close(done));
    rmSync(runtime, { recursive: true, force: true });
  }
});

const scratch = [];
after(() => {
  for (const dir of scratch) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function lastEvent(app, type) {
  const events = app.events.entries.filter((entry) => entry.type === type);
  assert.ok(events.length > 0, `no ${type} event was published`);
  return events[events.length - 1];
}

function ffprobeFrames(file) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nokey=1:noprint_wrappers=1', file], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `ffprobe failed: ${probe.stderr}`);
  return Number(probe.stdout.trim());
}

function postSceneRender(server, body) {
  return post(server, '/api/scene/render', body);
}

function postScenePlan(server, body) {
  return post(server, '/api/scene/plan', body);
}

test('a scene chip is a fixed scene-local edit that saves a new revision', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-c11-chip-'));
  scratch.push(runtime);
  const pkg = JSON.parse(readFileSync(join(TINY, 'package.json'), 'utf8'));
  const app = createApp({ token: TOKEN, runtimeDir: runtime, render: async () => ({ output: 'x', bytes: 0, frames: 0, hash: 'x' }) });
  app.store.write(pkg);
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const list = await get(server, '/api/scene/chips');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.chips.map((chip) => chip.id), ['warmer', 'calmer-motion', 'more-depth', 'less-busy']);

    const applied = await post(server, '/api/scene/chip', { packageId: pkg.id, baseRevision: pkg.revision, sceneId: 's_stat', chip: 'more-depth' });
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    assert.equal(applied.json.changed, true);
    assert.equal(applied.json.revision, pkg.revision + 1);
    assert.match(applied.json.summary, /parallax/i);
    assert.equal(applied.json.package.scenes[1].foreground[0].anim, 'parallax-in');

    // The save went through the validating store and only the target scene moved.
    const saved = app.store.read(pkg.id);
    assert.equal(saved.revision, pkg.revision + 1);
    assert.equal(saved.scenes[1].foreground[0].anim, 'parallax-in');
    assert.deepEqual(saved.scenes[0], pkg.scenes[0]);
    assert.deepEqual(saved.scenes[2], pkg.scenes[2]);
    assert.equal(lastEvent(app, 'scene.chip.applied').chip, 'more-depth');

    assert.equal((await post(server, '/api/scene/chip', { packageId: pkg.id, sceneId: 'nope', chip: 'warmer' })).status, 404);
    assert.equal((await post(server, '/api/scene/chip', { packageId: pkg.id, sceneId: 's_stat', chip: 'zoom' })).status, 400);
    // A stale base revision is refused, not silently overwritten.
    assert.equal((await post(server, '/api/scene/chip', { packageId: pkg.id, baseRevision: pkg.revision, sceneId: 's_stat', chip: 'warmer' })).status, 409);
  } finally {
    app.close();
    await new Promise((done) => server.close(done));
    rmSync(runtime, { recursive: true, force: true });
  }
});

function get(server, path) {
  const port = server.address().port;
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { 'x-comfyrizz-token': TOKEN, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolvePromise({ status: response.statusCode, headers: response.headers, json: text ? JSON.parse(text) : {} });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function post(server, path, body) {
  const port = server.address().port;
  const payload = JSON.stringify(body);
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'x-comfyrizz-token': TOKEN, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          resolvePromise({ status: response.statusCode, headers: response.headers, body: buffer, json: text && response.headers['content-type']?.includes('json') ? JSON.parse(text) : {} });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

test('the presenter route turns the H17 presenter on and off and saves a revision', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-cpres-'));
  scratch.push(runtime);
  const pkg = JSON.parse(readFileSync(join(TINY, 'package.json'), 'utf8'));
  pkg.presenter = { enabled: true, portrait: 'a_tiny_logo', scenes: 'all' };
  const app = createApp({ token: TOKEN, runtimeDir: runtime, render: async () => ({ output: 'x', bytes: 0, frames: 0, hash: 'x' }) });
  app.store.write(pkg);
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const chips = await get(server, '/api/presenter/chips');
    assert.equal(chips.status, 200);
    assert.deepEqual(chips.json.chips.map((chip) => chip.id), ['none', 'bookends', 'all']);
    assert.deepEqual(chips.json.presets.map((preset) => preset.id), ['intro-outro', 'all', 'none']);

    // The presenter clip / portrait is part of the scene's media.
    assert.ok(sceneAssetIds(pkg, 's_title').includes('a_tiny_logo'));

    const bookends = await post(server, '/api/presenter/set', { packageId: pkg.id, baseRevision: pkg.revision, coverage: 'bookends' });
    assert.equal(bookends.status, 200, JSON.stringify(bookends.json));
    assert.equal(bookends.json.revision, pkg.revision + 1);
    assert.equal(bookends.json.presenter.scenes, 'bookends');
    assert.match(bookends.json.portrait_prompt, /Fictional person/);
    assert.equal(lastEvent(app, 'presenter.set').summary, 'presenter on (bookends)');

    // A per-scene override saves too.
    const saved = app.store.read(pkg.id);
    const off = await post(server, '/api/presenter/set', { packageId: pkg.id, baseRevision: saved.revision, scenes: { s_stat: 'off' } });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(app.store.read(pkg.id).scenes.find((scene) => scene.id === 's_stat').presenter, 'off');

    // The whole-video preset turns it off.
    const off2 = await post(server, '/api/presenter/set', { packageId: pkg.id, baseRevision: app.store.read(pkg.id).revision, coverage: 'none' });
    assert.equal(off2.status, 200);
    assert.equal(app.store.read(pkg.id).presenter.enabled, false);

    assert.equal((await post(server, '/api/presenter/set', { packageId: pkg.id, scenes: { nope: 'pip' } })).status, 404);
    assert.equal((await post(server, '/api/presenter/set', { packageId: pkg.id, coverage: 'sometimes' })).status, 400);
  } finally {
    app.close();
    await new Promise((done) => server.close(done));
    rmSync(runtime, { recursive: true, force: true });
  }
});
