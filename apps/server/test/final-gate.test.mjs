// IP54: one final-delivery gate across every render/export caller.
//
// The server can deliver a final file through five callers: /api/export,
// /api/render, /api/scene/render, /api/render/edited and the full production
// pipeline (/api/pipeline). Each one must consult the same readiness before it
// starts any renderer, exporter or paid pipeline, and each one must report the
// same RENDER_GATE_BLOCKED shape with the path it came from.
//
// Local only: the renderer and scene renderer are stubs. No network, no Google Colab
// session, no real render.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedMockContribution, approveMockContribution } from './helpers/comfy-contribution.mjs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';

import { createApp } from '../src/app.mjs';
import { PackageStore } from '../src/store.mjs';
import { createRenderRoutes, DELIVERY_ROUTE_PATHS } from '../src/routes/render.mjs';
import { CPU_GENERATORS, finalGate } from '../src/takes/gate.mjs';

const TOKEN = 'final-gate-token-0123456789abcdef';
const FIXTURE_PATH = new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const ASSET_ID = 'a_plate1';
const CLIP_ID = `s1:${ASSET_ID}`;
const REASON = 'owner reviewed every cut by hand';
const DELIVERY_CALLERS = Object.freeze([
  '/api/export',
  '/api/render',
  '/api/scene/render',
  '/api/render/edited',
  '/api/pipeline',
]);

const clone = value => JSON.parse(JSON.stringify(value));

function fixturePackage() {
  const pkg = clone(fixture);
  pkg.scenes.forEach(scene => { delete scene.narration; });
  // A one-scene package must not carry a transition out; this test is about the
  // delivery gate rather than the timeline transition rule.
  if (Array.isArray(pkg.scenes) && pkg.scenes.length === 1) delete pkg.scenes[0].transitionOut;
  return pkg;
}

function seedPackage(app, pkg) {
  const dir = dirname(app.store.path(pkg.id));
  for (const asset of Object.values(pkg.assets ?? {})) {
    const files = [asset?.file, ...Object.values(asset?.variants ?? {}).map(variant => variant?.file)]
      .filter(file => typeof file === 'string' && file);
    for (const relative of files) {
      const file = join(dir, relative);
      mkdirSync(dirname(file), { recursive: true });
      const bytes = Buffer.from(`fixture ${relative}`);
      if (!existsSync(file)) writeFileSync(file, bytes);
      if (relative === asset.file) asset.sha256 = createHash('sha256').update(bytes).digest('hex');
      const variant = Object.values(asset?.variants ?? {}).find(item => item?.file === relative);
      if (variant) variant.sha256 = createHash('sha256').update(bytes).digest('hex');
    }
  }
  seedMockContribution(app.store, pkg);
  approveMockContribution(app.takeStore, pkg, dir);
  return dir;
}

function addUnreviewedTake(app, pkg, sourceDir) {
  const source = join(sourceDir, 'final-gate-source.mp4');
  writeFileSync(source, 'final gate take bytes');
  return app.takeStore.addTake(pkg.id, ASSET_ID, {
    srcPath: source,
    media: clone(pkg.assets[ASSET_ID].media),
    gen: clone(pkg.assets[ASSET_ID].gen),
    runId: 'run_final_gate',
  });
}

function renderCounters() {
  const renderCalls = [];
  const sceneCalls = [];
  return {
    renderCalls,
    sceneCalls,
    render: async (packagePath, output) => {
      renderCalls.push({ packagePath, output });
      writeFileSync(output, 'unexpected final render');
      return { output, bytes: 22, frames: 1, hash: 'final-gate-render' };
    },
    renderScene: async (packagePath, output) => {
      sceneCalls.push({ packagePath, output });
      writeFileSync(output, 'unexpected scene render');
      return {
        output,
        bytes: 21,
        frames: 1,
        timelineHash: 'final-gate-scene',
        rendered: [],
        reused: [],
        segments: [],
      };
    },
  };
}

async function withServer(app, fn) {
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, 'x-comfyrizz-token': TOKEN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    return await fn({ base, request });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('IP54: the delivery table names every non-pipeline render/export caller', () => {
  assert.deepEqual(
    [...DELIVERY_ROUTE_PATHS].sort(),
    ['/api/export', '/api/render', '/api/render/edited', '/api/scene/render'].sort(),
  );
  assert.equal(DELIVERY_ROUTE_PATHS.length, new Set(DELIVERY_ROUTE_PATHS).size, 'each caller appears once');
});

test('IP54: every delivery caller uses the one final gate and starts no work while blocked', async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ip54-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));

  const counters = renderCounters();
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    render: counters.render,
    renderScene: counters.renderScene,
  });
  t.after(() => app.close());

  const pkg = fixturePackage();
  const dir = seedPackage(app, pkg);
  const take = addUnreviewedTake(app, pkg, dir);
  assert.ok(take?.takeId, 'the take landed as an unreviewed candidate');

  await withServer(app, async ({ request }) => {
    const bodies = {
      '/api/export': { packageId: pkg.id, baseRevision: pkg.revision },
      '/api/render': { packageId: pkg.id, baseRevision: pkg.revision },
      '/api/scene/render': { packageId: pkg.id, baseRevision: pkg.revision, sceneId: 's1' },
      '/api/render/edited': { packageId: pkg.id, baseRevision: pkg.revision },
      '/api/pipeline': { packageId: pkg.id, baseRevision: pkg.revision, backendId: 'cpu' },
    };

    for (const path of DELIVERY_CALLERS) {
      const response = await request(path, bodies[path]);
      assert.equal(response.status, 409, `${path}: ${await response.clone().text()}`);
      const payload = await response.json();
      assert.equal(payload.code, 'RENDER_GATE_BLOCKED', `${path} names the shared gate refusal`);
      assert.equal(payload.approved, 1, `${path} reports the reviewed supporting plate`);
      assert.equal(payload.total, 2, `${path} reports the shared clip total`);
      assert.deepEqual(payload.blocking, [{ clipId: CLIP_ID, state: 'review' }], `${path} reports the shared blockers`);
    }

    assert.equal(counters.renderCalls.length, 0, 'no final renderer was reached');
    assert.equal(counters.sceneCalls.length, 0, 'no scene renderer was reached');
    assert.equal(app.pipelines.list().length, 0, 'no pipeline was admitted');

    const blockedPaths = app.events.entries
      .filter(entry => entry.type === 'render.gate.blocked')
      .map(entry => entry.path);
    assert.deepEqual(
      [...blockedPaths].sort(),
      [...DELIVERY_CALLERS].sort(),
      'each caller journals the path it came from',
    );
    for (const entry of app.events.entries.filter(event => event.type === 'render.gate.blocked')) {
      assert.equal(entry.packageId, pkg.id);
      assert.equal(entry.blocking.length, 1);
    }
  });
});

test('IP54: a written override opens every enumerated route through the same gate', async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ip54-override-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));

  const store = new PackageStore(join(runtimeDir, 'packages'));
  mkdirSync(join(runtimeDir, 'renders'), { recursive: true });
  const pkg = fixturePackage();
  seedMockContribution(store, pkg);
  const events = { entries: [], publish(event) { this.entries.push(event); } };
  const gates = [];
  const calls = [];
  const exporter = async args => {
    calls.push({ kind: 'export', args });
    return { dir: join(runtimeDir, 'export'), files: [], social: [], frames: 1, captions: 0, complete: true, excluded: [] };
  };
  exporter.variants = async args => {
    calls.push({ kind: 'export-variants', args });
    return { dir: join(runtimeDir, 'export'), manifestPath: 'manifest.json', manifest: { variants: [] } };
  };
  const routes = createRenderRoutes({
    store,
    events,
    exporter,
    render: async (_packagePath, output) => {
      calls.push({ kind: 'render' });
      writeFileSync(output, 'final gate override render');
      return { output, bytes: 27, frames: 1, hash: 'override-render' };
    },
    renderScene: async (_packagePath, output) => {
      calls.push({ kind: 'scene' });
      writeFileSync(output, 'final gate override scene');
      return {
        output,
        bytes: 26,
        frames: 1,
        timelineHash: 'override-scene',
        rendered: [],
        reused: [],
        segments: [],
      };
    },
    qa: { record() {} },
    rendersDir: join(runtimeDir, 'renders'),
    sceneCacheDir: id => join(runtimeDir, 'scene-cache', id),
    operations: { tryAcquire: () => ({ busy: false, release() {} }) },
    requireReadiness: true,
    renderGate: (target, body, pathname) => {
      gates.push(pathname);
      if (typeof body?.override?.reason === 'string') return null;
      return {
        status: 409,
        body: {
          error: '1 of 1 clip(s) still need approval',
          code: 'RENDER_GATE_BLOCKED',
          approved: 0,
          total: 1,
          blocking: [{ clipId: CLIP_ID, state: 'review' }],
        },
      };
    },
    draftRenderTarget: () => {
      throw new Error('drafts are not part of this test');
    },
    resolveRenderTarget: body => ({ pkg, packagePath: store.path(pkg.id), revision: pkg.revision, ...(body.sceneId ? { sceneId: body.sceneId } : {}) }),
    sendJson: (response, status, value) => {
      const body = JSON.stringify(value);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    },
    readJson: async request => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    },
  });

  const bodies = {
    '/api/export': { packageId: pkg.id, baseRevision: pkg.revision, override: { reason: REASON } },
    '/api/render': { packageId: pkg.id, baseRevision: pkg.revision, override: { reason: REASON } },
    '/api/scene/render': { packageId: pkg.id, baseRevision: pkg.revision, sceneId: 's1', override: { reason: REASON } },
    '/api/render/edited': { packageId: pkg.id, baseRevision: pkg.revision, override: { reason: REASON } },
  };

  for (const path of DELIVERY_ROUTE_PATHS) {
    const response = fakeResponse();
    const handled = await routes.handle(fakeRequest(bodies[path]), response, new URL(`http://127.0.0.1${path}`));
    assert.equal(handled, true, `${path} is handled by the delivery route table`);
    if (!response.writableFinished) await new Promise(resolve => response.once('finish', resolve));
    assert.equal(response.out.status, 200, `${path}: ${response.out.body}`);
  }

  assert.deepEqual(gates, [...DELIVERY_ROUTE_PATHS], 'each caller evaluated the shared gate once');
  assert.equal(calls.filter(call => call.kind === 'export').length, 1);
  assert.equal(calls.filter(call => call.kind === 'render').length, 1);
  assert.equal(calls.filter(call => call.kind === 'scene').length, 2, 'scene and edited render both reach the scene renderer');
});

function fakeRequest(body) {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  stream.method = 'POST';
  return stream;
}

function fakeResponse() {
  const out = { status: null, headers: null, body: null, chunks: [], finished: false };
  const response = new Writable({
    write(chunk, _encoding, callback) {
      out.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
    final(callback) {
      out.body = Buffer.concat(out.chunks).toString('utf8');
      out.finished = true;
      callback();
    },
  });
  response.out = out;
  response.headersSent = false;
  response.writeHead = (status, headers = {}) => {
    out.status = status;
    out.headers = headers;
    response.headersSent = true;
    return response;
  };
  return response;
}

function cpuPackage(generators) {
  const assets = {};
  const clips = [];
  generators.forEach((generator, index) => {
    const assetId = `a_${index}`;
    assets[assetId] = { gen: { generator, inputs: { prompt: `card ${index}` } } };
    clips.push({ clipId: `s1:${assetId}`, assetId });
  });
  return { pkg: { assets }, clips };
}

test('UR31: four llm-svg assets with no takes are approved', () => {
  assert.equal(CPU_GENERATORS.has('llm-svg'), true);
  const { pkg, clips } = cpuPackage(['llm-svg', 'llm-svg', 'llm-svg', 'llm-svg']);
  const gate = finalGate(pkg, null, clips);
  assert.equal(gate.ok, true);
  assert.equal(gate.autoApproved, 4);
  assert.equal(gate.approved, 4);
  assert.equal(gate.total, 4);
  assert.deepEqual(gate.blocking, []);
});

test('UR31: a flux3-klein asset with no takes still blocks', () => {
  const { pkg, clips } = cpuPackage(['flux3-klein']);
  const gate = finalGate(pkg, null, clips);
  assert.equal(gate.ok, false);
  assert.equal(gate.autoApproved, 0);
  assert.equal(gate.approved, 0);
  assert.deepEqual(gate.blocking, [{ clipId: 's1:a_0', state: 'planned' }]);
});

test('UR31: a ready uploaded still with no takes is approved', () => {
  const pkg = { assets: { a_kevin: { kind: 'image', origin: 'upload', status: 'ready', file: 'assets/kevin.jpg' } } };
  const gate = finalGate(pkg, null, [{ clipId: 's1:a_kevin', assetId: 'a_kevin' }]);
  assert.equal(gate.ok, true);
  assert.equal(gate.autoApproved, 1);
  assert.equal(gate.approved, 1);
  assert.deepEqual(gate.blocking, []);
});

test('UR31: a ready stock still with no takes is approved', () => {
  const pkg = { assets: { a_chart: { kind: 'image', origin: 'stock', status: 'ready', file: 'assets/chart.png' } } };
  const gate = finalGate(pkg, null, [{ clipId: 's1:a_chart', assetId: 'a_chart' }]);
  assert.equal(gate.ok, true);
  assert.equal(gate.autoApproved, 1);
  assert.equal(gate.approved, 1);
  assert.deepEqual(gate.blocking, []);
});

test('UR31: ready uploaded or stock video and audio are not auto-approved', () => {
  const pkg = {
    assets: {
      a_video: { kind: 'video', origin: 'upload', status: 'ready', file: 'assets/clip.mp4' },
      a_audio: { kind: 'audio', origin: 'stock', status: 'ready', file: 'assets/bed.wav' },
      a_pending: { kind: 'image', origin: 'upload', status: 'pending' },
    },
  };
  const gate = finalGate(pkg, null, [
    { clipId: 's1:a_video', assetId: 'a_video' },
    { clipId: 's1:a_audio', assetId: 'a_audio' },
    { clipId: 's1:a_pending', assetId: 'a_pending' },
  ]);
  assert.equal(gate.ok, false);
  assert.equal(gate.autoApproved, 0);
  assert.equal(gate.approved, 0);
  assert.deepEqual(gate.blocking, [
    { clipId: 's1:a_video', state: 'planned' },
    { clipId: 's1:a_audio', state: 'planned' },
    { clipId: 's1:a_pending', state: 'planned' },
  ]);
});

test('UR31: a ready LTX presenter clip with no takes still needs a take', () => {
  const pkg = { assets: { a_presenter: { kind: 'video', origin: 'generated', status: 'ready', gen: { generator: 'ltx25-a2v' } } } };
  const gate = finalGate(pkg, null, [{ clipId: 's1:a_presenter', assetId: 'a_presenter' }]);
  assert.equal(gate.ok, false);
  assert.equal(gate.autoApproved, 0);
  assert.equal(gate.approved, 0);
  assert.deepEqual(gate.blocking, [{ clipId: 's1:a_presenter', state: 'planned' }]);
});

test('UR31: a ready LTX presenter clip with an approved take passes the gate', () => {
  const gen = { generator: 'ltx25-a2v', inputs: { prompt: 'a presenter' } };
  const take = {
    takeId: 'tk_kept00000001',
    n: 1,
    gen,
    verdict: 'approved',
    createdAt: '2026-10-20T12:00:00.000Z',
  };
  const pkg = { assets: { a_presenter: { kind: 'video', origin: 'generated', status: 'ready', gen } } };
  const gate = finalGate(pkg, {
    schema: 'comfyrizz.takes/v1',
    clips: { a_presenter: { selected: take.takeId, takes: [take] } },
  }, [{ clipId: 's1:a_presenter', assetId: 'a_presenter' }]);
  assert.equal(gate.ok, true);
  assert.equal(gate.autoApproved, 0);
  assert.equal(gate.approved, 1);
  assert.deepEqual(gate.blocking, []);
});

test('UR31: an llm-svg asset with a rejected take still blocks', () => {
  const gen = { generator: 'llm-svg', inputs: { prompt: 'a title card' } };
  const pkg = { assets: { a_svg: { gen } } };
  const take = {
    takeId: 'tk_rejected01',
    n: 1,
    gen,
    verdict: 'rejected',
    createdAt: '2026-10-20T12:00:00.000Z',
  };
  const gate = finalGate(pkg, {
    schema: 'comfyrizz.takes/v1',
    clips: { a_svg: { selected: take.takeId, takes: [take] } },
  }, [{ clipId: 's1:a_svg', assetId: 'a_svg' }]);
  assert.equal(gate.ok, false);
  assert.equal(gate.autoApproved, 0);
  assert.deepEqual(gate.blocking, [{ clipId: 's1:a_svg', state: 'rejected' }]);
});
