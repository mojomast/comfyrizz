// C13 acceptance: an agent edit re-renders only the scenes that changed.
//
// The package is built by the CPU agent slice through a loopback stub LLM provider (no
// network, no key). A first `POST /api/render/edited` renders every scene and fills the
// A6 segment cache; a second agent run applies one `storyboard.edit` ("make scene 1
// warmer") and only that scene's segment is re-rendered, every other cache file keeps its
// mtime and the MP4 still has the compiled frame count. A timing edit (scene duration)
// instead falls back to a full render and says why.
//
// The frame source is stubbed with ffmpeg, so this needs no browser and no GPU; the
// timeline diff, cache keys, concat and ffprobe are the real ones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { defaultCpuScript } from '../../../packages/agent/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { renderPackageIncremental } from '../../renderer/scripts/render-incremental.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { replayProvider } from './fake-provider.mjs';

const TOKEN = 'c13-token-0123456789abcdef';
const BRIEF =
  'Icon, diagram, pattern, bars; nebula launch.';
const WARM_PALETTE = ['#2a1206', '#4a1f08', '#ffb37b'];
const EDIT = {
  name: 'storyboard.edit',
  args: { scene_id: 's_title', patch: { background: { procedural: { pattern: 'mesh', seed: 99, palette: WARM_PALETTE } } } },
};

let runtime;
let app;
let server;
let port;
let provider;
const state = { packageId: null };

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-c13-'));
  provider = await replayProvider(defaultCpuScript(BRIEF), { svgText: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#f2f2f2"/><text x="10" y="60" fill="#050505">Launch</text></svg>' });
  app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    render: fullRenderStub,
    renderScene: (packagePath, outputPath, options) =>
      renderPackageIncremental(packagePath, outputPath, { ...options, renderSegment: stubSegment }),
    agentRunner: createCpuAgentRunner({ runtimeDir: runtime, providers: { custom: { baseUrl: provider.url } } }),
  });
  server = createServer(app.handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  port = server.address().port;
});

after(async () => {
  app.close();
  await new Promise(done => server.close(done));
  await provider.close();
  rmSync(runtime, { recursive: true, force: true });
});

test('a stub-agent one-scene edit re-renders only that scene; a duration edit falls back to a full render', { timeout: 300_000 }, async () => {
  // 1. The stub LLM provider builds a valid package (same path as C8).
  const built = await request({ method: 'POST', path: '/api/agent', body: { brief: BRIEF, provider: 'custom', model: 'local-compatible' } });
  assert.equal(built.status, 200, built.text.slice(0, 800));
  assert.equal(built.json.live, true);
  assert.equal(built.json.fallback, false, 'the scripted run must not fall back');
  assert.equal(validatePackage(built.json.package).valid, true, JSON.stringify(validatePackage(built.json.package).errors));
  state.packageId = built.json.package.id;
  const baseTimeline = built.json.timeline;
  assert.equal(baseTimeline.scenes.length, 6);
  const sceneCount = baseTimeline.scenes.length;

  // 2. Baseline render: everything renders and the segment cache is populated.
  const first = await renderEdited(state.packageId);
  assert.equal(first.status, 200, first.text.slice(0, 800));
  assert.equal(first.headers['x-comfyrizz-full-render'], '0');
  assert.equal(first.headers['x-comfyrizz-rendered-count'], String(sceneCount));
  assert.equal(first.headers['x-comfyrizz-reused-count'], '0');
  assert.equal(Number(first.headers['x-comfyrizz-frames']), baseTimeline.durationInFrames);

  const cacheDir = app.sceneCacheDir(state.packageId);
  const before = segmentMtimes(cacheDir);
  assert.equal(before.size, sceneCount, 'one cache file per scene after the baseline render');

  // 3. A second stub-agent run applies exactly one storyboard.edit (scene 1 palette warmer).
  provider.setCalls([...defaultCpuScript(BRIEF), EDIT]);
  const edited = await request({ method: 'POST', path: '/api/agent', body: { brief: BRIEF, provider: 'custom', model: 'local-compatible' } });
  assert.equal(edited.status, 200, edited.text.slice(0, 800));
  assert.equal(edited.json.package.id, state.packageId);
  assert.equal(edited.json.fallback, false, 'the edit run must not fall back');
  const warm = edited.json.package.scenes.find(scene => scene.id === 's_title');
  assert.deepEqual(warm.background.procedural.palette, WARM_PALETTE, 'the edit reached scene s_title');
  assert.equal(compileTimeline(edited.json.package).durationInFrames, baseTimeline.durationInFrames, 'a content edit does not move timing');

  // 4. Only s_title's segment re-renders; the other cache files keep their mtimes.
  const second = await renderEdited(state.packageId);
  assert.equal(second.status, 200, second.text.slice(0, 800));
  assert.equal(second.headers['x-comfyrizz-full-render'], '0');
  assert.equal(second.headers['x-comfyrizz-rendered'], 's_title');
  assert.equal(second.headers['x-comfyrizz-rendered-count'], '1');
  assert.equal(second.headers['x-comfyrizz-reused-count'], String(sceneCount - 1));
  assert.equal(Number(second.headers['x-comfyrizz-frames']), baseTimeline.durationInFrames, 'the edited render still matches the compiled timeline');
  const editedFinish = lastEvent('edit.render.finished');
  assert.equal(editedFinish.full, false);
  assert.deepEqual(editedFinish.rendered, ['s_title']);
  assert.equal(editedFinish.reused.length, sceneCount - 1);

  const after = segmentMtimes(cacheDir);
  for (const [file, mtime] of before) {
    assert.equal(after.get(file), mtime, `${file} was rewritten although its scene did not change`);
  }
  const added = [...after.keys()].filter(file => !before.has(file));
  assert.equal(added.length, 1, 'exactly one new segment file was written (the edited scene)');

  // The full-length MP4 really is the compiled frame count.
  const output = join(runtime, 'c13-edited.mp4');
  writeFileSync(output, second.body);
  assert.equal(ffprobeFrames(output), baseTimeline.durationInFrames);

  // 5. A duration edit moves the frame grid, so the endpoint falls back to a full render.
  const current = app.store.read(state.packageId);
  const timed = structuredClone(current);
  const stat = timed.scenes.find(scene => scene.id === 's_stat');
  stat.preferredFrames += 60;
  const timedFrames = compileTimeline(timed).durationInFrames;
  assert.notEqual(timedFrames, baseTimeline.durationInFrames, 'the duration edit really moves timing');
  app.store.save(state.packageId, timed, current.revision);

  const third = await renderEdited(state.packageId);
  assert.equal(third.status, 200, third.text.slice(0, 800));
  assert.equal(third.headers['x-comfyrizz-full-render'], '1');
  assert.equal(third.headers['x-comfyrizz-full-reason'], 'scene durations changed');
  assert.equal(third.headers['x-comfyrizz-rendered-count'], String(sceneCount));
  assert.equal(third.headers['x-comfyrizz-reused-count'], '0');
  assert.equal(Number(third.headers['x-comfyrizz-frames']), timedFrames);
  const timedFinish = lastEvent('edit.render.finished');
  assert.equal(timedFinish.full, true);
  assert.equal(timedFinish.reason, 'scene durations changed');
  assert.deepEqual(timedFinish.rendered.sort(), baseTimeline.scenes.map(scene => scene.id).sort());

  const timedOutput = join(runtime, 'c13-timed.mp4');
  writeFileSync(timedOutput, third.body);
  assert.equal(ffprobeFrames(timedOutput), timedFrames, 'the full fallback render matches the new timeline');
});

/** A real H.264 clip with exactly `segment.frames` frames (no browser). */
function stubSegment(segment, segmentPath) {
  const seconds = (segment.frames / 30).toFixed(6);
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=640x360:r=30:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', segmentPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`stub segment failed: ${result.stderr}`);
}

/** Stand-in for the full render path: an H.264 clip with the compiled frame count. */
function fullRenderStub(packagePath, outputPath) {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const timeline = compileTimeline(pkg);
  const seconds = (timeline.durationInFrames / 30).toFixed(6);
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=640x360:r=30:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', outputPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`full render stub failed: ${result.stderr}`);
  return { output: outputPath, bytes: statSync(outputPath).size, frames: timeline.durationInFrames, hash: timeline.hash, timeline, package: pkg };
}

function segmentMtimes(cacheDir) {
  const map = new Map();
  for (const file of readdirSync(cacheDir)) {
    if (!/^[0-9a-f]{32}\.mp4$/.test(file)) continue;
    const path = join(cacheDir, file);
    map.set(file, statSync(path).mtimeMs);
  }
  return map;
}

function lastEvent(type) {
  const matches = app.events.entries.filter(entry => entry.type === type);
  assert.ok(matches.length > 0, `no ${type} event was published`);
  return matches[matches.length - 1];
}

function ffprobeFrames(file) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nokey=1:noprint_wrappers=1', file], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `ffprobe failed: ${probe.stderr}`);
  return Number(probe.stdout.trim());
}

function renderEdited(packageId) {
  return binaryRequest('/api/render/edited', { packageId, intent: 'draft' });
}

function request({ method = 'GET', path = '/', body } = {}) {
  return binaryRequest(path, body, method).then(response => ({ ...response, json: response.contentType?.includes('json') ? JSON.parse(response.text || '{}') : {} }));
}

function binaryRequest(path, body, method = 'POST') {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'x-comfyrizz-token': TOKEN };
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolvePromise({
          status: response.statusCode,
          headers: response.headers,
          contentType: response.headers['content-type'],
          body: buffer,
          text: buffer.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
