// IP25: legacy closure. /api/export, /api/render, /api/scene/render and
// /api/render/edited all consult the same render readiness. Evaluating readiness
// (a blocked request) never renders, exports or journals paid work; an explicit
// override or a production-bound request is the only way through. A production-
// bound render journals gate.override and render.request before it renders, so
// the legacy route is an adapter into the one production command path.
//
// Local only: the renderer, scene renderer and exporter are stubs. No network,
// no Google Colab session, no real render.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { PackageStore } from '../src/store.mjs';
import { createTakeStore } from '../src/takes/store.mjs';
import { createProductionStore } from '../src/productions/store.mjs';
import { createCommandHandler } from '../src/productions/commands.mjs';
import { createRenderRoutes } from '../src/routes/render.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url),
  'utf8',
));
const FAKE_MP4 = 'ip25 fake mp4 bytes';
const REASON = 'owner reviewed every cut by hand';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-ip25-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDir = join(root, 'runtime');
  const packagesDir = join(runtimeDir, 'packages');
  const rendersDir = join(runtimeDir, 'renders');
  mkdirSync(packagesDir, { recursive: true });
  mkdirSync(rendersDir, { recursive: true });
  return { root, runtimeDir, packagesDir, rendersDir };
}

function fakeRequest(body, method = 'POST') {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  stream.method = method;
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

async function call(routes, pathname, body) {
  const response = fakeResponse();
  const handled = await routes.handle(fakeRequest(body), response, new URL(`http://127.0.0.1${pathname}`));
  if (!response.writableFinished) {
    await new Promise(resolve => response.once('finish', resolve));
  }
  let json = null;
  try { json = response.out.body ? JSON.parse(response.out.body) : null; } catch { json = null; }
  return { handled, status: response.out.status, headers: response.out.headers, body: response.out.body, json };
}

function stubRender(calls, bytes = FAKE_MP4) {
  return async (packagePath, output) => {
    calls.push({ kind: 'render', packagePath, output });
    writeFileSync(output, bytes);
    return { output, bytes: Buffer.byteLength(bytes), frames: 12, hash: 'ip25hash' };
  };
}

function stubRenderScene(calls) {
  return async (packagePath, output) => {
    calls.push({ kind: 'scene', packagePath, output });
    writeFileSync(output, FAKE_MP4);
    return {
      output,
      bytes: Buffer.byteLength(FAKE_MP4),
      frames: 12,
      timelineHash: 'ip25hash',
      rendered: ['s1:0'],
      reused: [],
      segments: [{ key: 's1:0', sceneId: 's1' }],
      full: false,
      reason: null,
    };
  };
}

function stubExporter(calls) {
  const exporter = async args => {
    calls.push({ kind: 'export', args });
    return {
      dir: join(args.packagePath, '..', 'export'),
      files: [],
      social: [],
      frames: 12,
      captions: 0,
      complete: true,
      excluded: [],
    };
  };
  exporter.variants = async args => {
    calls.push({ kind: 'export-variants', args });
    return { dir: join(args.packagePath, '..', 'export'), manifestPath: 'manifest.json', manifest: { variants: [] } };
  };
  return exporter;
}

function makeRoutes(t, { production = null, renderGate, requireReadiness = false } = {}) {
  const space = workspace(t);
  const store = new PackageStore(space.packagesDir);
  const pkg = clone(fixture);
  pkg.id = 'pkg_ip25render01';
  pkg.revision = 3;
  // The fixture's only scene carries a transition out; a one-scene package must
  // not, and this test is about the routes rather than that timeline rule.
  if (Array.isArray(pkg.scenes) && pkg.scenes.length === 1) delete pkg.scenes[0].transitionOut;
  store.write(pkg);
  const takeStore = createTakeStore({ runtimeDir: space.runtimeDir, packageDir: space.packagesDir });
  const events = { entries: [], publish(event) { this.entries.push(event); } };
  const calls = [];
  const gates = [];
  const readiness = typeof renderGate === 'function'
    ? (target, body, pathname) => {
      gates.push(pathname);
      return renderGate(target, body, pathname);
    }
    : () => null;
  const routes = createRenderRoutes({
    store,
    events,
    exporter: stubExporter(calls),
    render: stubRender(calls),
    renderScene: stubRenderScene(calls),
    qa: { record() {} },
    rendersDir: space.rendersDir,
    sceneCacheDir: id => join(space.runtimeDir, 'scene-cache', id),
    operations: { tryAcquire: () => ({ busy: false, release() {} }) },
    renderGate: readiness,
    requireReadiness,
    production: production ? async () => production : null,
    draftRenderTarget: () => {
      throw new Error('drafts are not part of this test');
    },
    resolveRenderTarget: (body) => {
      const id = body.packageId;
      if (!id) {
        const error = new Error('packageId or package required');
        error.status = 400;
        throw error;
      }
      const target = store.read(id);
      if (!target) {
        const error = new Error('package not found');
        error.status = 404;
        throw error;
      }
      if (body.baseRevision != null && Number(body.baseRevision) !== target.revision) {
        const error = new Error('conflict');
        error.status = 409;
        error.currentRevision = target.revision;
        throw error;
      }
      return { pkg: target, packagePath: store.path(id), revision: target.revision };
    },
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
  return { space, store, pkg, takeStore, events, calls, gates, routes };
}

function blockedGate(gates) {
  return (pkg, body, pathname) => {
    if (typeof body?.override?.reason === 'string') return null;
    gates.push({ pkg: pkg.id, pathname });
    return {
      status: 409,
      body: {
        error: '1 of 1 clip(s) still need approval',
        code: 'RENDER_GATE_BLOCKED',
        approved: 0,
        total: 1,
        blocking: [{ clipId: 's1:a_plate1', state: 'review' }],
      },
    };
  };
}

test('IP25: export, render, scene render and edited render all consult shared readiness', async t => {
  const ctx = makeRoutes(t, { renderGate: blockedGate([]), requireReadiness: true });
  const base = { packageId: ctx.pkg.id, baseRevision: ctx.pkg.revision };

  const exportBlocked = await call(ctx.routes, '/api/export', base);
  assert.equal(exportBlocked.status, 409, exportBlocked.body);
  assert.equal(exportBlocked.json.code, 'RENDER_GATE_BLOCKED');
  assert.equal(ctx.calls.length, 0, 'a blocked export never renders or exports');

  const renderBlocked = await call(ctx.routes, '/api/render', base);
  assert.equal(renderBlocked.status, 409, renderBlocked.body);
  assert.equal(renderBlocked.json.code, 'RENDER_GATE_BLOCKED');
  assert.equal(ctx.calls.length, 0, 'a blocked full render never renders');

  const sceneBlocked = await call(ctx.routes, '/api/scene/render', { ...base, sceneId: 's1' });
  assert.equal(sceneBlocked.status, 409, sceneBlocked.body);
  assert.equal(sceneBlocked.json.code, 'RENDER_GATE_BLOCKED');
  assert.equal(ctx.calls.length, 0, 'a blocked scene render never renders');

  const editedBlocked = await call(ctx.routes, '/api/render/edited', base);
  assert.equal(editedBlocked.status, 409, editedBlocked.body);
  assert.equal(editedBlocked.json.code, 'RENDER_GATE_BLOCKED');
  assert.equal(ctx.calls.length, 0, 'a blocked edited render never renders');

  assert.deepEqual(ctx.gates, [
    '/api/export',
    '/api/render',
    '/api/scene/render',
    '/api/render/edited',
  ], 'every legacy route asked the same readiness');
});

test('IP25: a written override opens each legacy route and the paid work is admitted once', async t => {
  const ctx = makeRoutes(t, { renderGate: blockedGate([]), requireReadiness: true });
  const base = { packageId: ctx.pkg.id, baseRevision: ctx.pkg.revision, override: { reason: REASON } };

  const exported = await call(ctx.routes, '/api/export', base);
  assert.equal(exported.status, 200, exported.body);
  assert.equal(ctx.calls.filter(call => call.kind === 'export').length, 1);

  const rendered = await call(ctx.routes, '/api/render', base);
  assert.equal(rendered.status, 200, rendered.body);
  assert.equal(rendered.body, FAKE_MP4);
  assert.equal(ctx.calls.filter(call => call.kind === 'render').length, 1);

  const scene = await call(ctx.routes, '/api/scene/render', { ...base, sceneId: 's1' });
  assert.equal(scene.status, 200, scene.body);
  assert.equal(ctx.calls.filter(call => call.kind === 'scene').length, 1);

  const edited = await call(ctx.routes, '/api/render/edited', base);
  assert.equal(edited.status, 200, edited.body);
  assert.equal(ctx.calls.filter(call => call.kind === 'scene').length, 2, 'the first edited render uses the incremental renderer');
});

test('IP25: a blocked production-bound render journals nothing and starts no paid work', async t => {
  const production = makeProduction(t);
  const ctx = makeRoutes(t, { production, renderGate: blockedGate([]) });
  const before = production.store.readEvents(production.productionId).length;

  const response = await call(ctx.routes, '/api/render', {
    packageId: ctx.pkg.id,
    commandId: 'cmd_blocked_render',
    idempotencyKey: 'key_blocked_render',
    expected: { productionRevision: production.revision },
  });

  assert.equal(response.status, 409, response.body);
  assert.equal(response.json.code, 'RENDER_GATE_BLOCKED');
  assert.equal(ctx.calls.length, 0, 'planning a blocked render is side-effect free');
  assert.equal(production.store.readEvents(production.productionId).length, before, 'no command was journaled');
});

test('IP25: an overridden production-bound render journals override and request before rendering', async t => {
  const production = makeProduction(t);
  const ctx = makeRoutes(t, { production, renderGate: blockedGate([]) });

  const response = await call(ctx.routes, '/api/render', {
    packageId: ctx.pkg.id,
    baseRevision: ctx.pkg.revision,
    override: { reason: REASON },
    commandId: 'cmd_render',
    idempotencyKey: 'key_render',
    expected: { productionRevision: production.revision },
  });

  assert.equal(response.status, 200, response.body);
  assert.equal(response.body, FAKE_MP4);
  assert.equal(ctx.calls.filter(call => call.kind === 'render').length, 1);
  assert.equal(response.headers['x-comfyrizz-production-id'], production.productionId);
  assert.equal(response.headers['x-comfyrizz-command-id'], 'cmd_render');

  const events = production.store.readEvents(production.productionId);
  const observed = events.find(event => event.type === 'review.observed');
  const requested = events.find(event => event.type === 'action.planned');
  assert.ok(observed, 'gate.override is journaled');
  assert.equal(observed.commandId, 'cmd_render:override');
  assert.equal(observed.data.reason, REASON);
  assert.ok(requested, 'render.request is journaled');
  assert.equal(requested.commandId, 'cmd_render');
  assert.equal(requested.data.path, '/api/render');
  assert.ok(events.indexOf(observed) < events.indexOf(requested), 'the override is recorded before the render request');
});

test('IP25: the legacy export is unchanged when no production binding and no review exists', async t => {
  const ctx = makeRoutes(t, { renderGate: blockedGate([]), requireReadiness: false });
  const before = ctx.gates.length;
  const response = await call(ctx.routes, '/api/export', {
    packageId: ctx.pkg.id,
    baseRevision: ctx.pkg.revision,
  });
  assert.equal(response.status, 200, response.body);
  assert.equal(ctx.gates.length, before, 'legacy export without review does not consult the gate');
  assert.equal(ctx.calls.filter(call => call.kind === 'export').length, 1);
});

function makeProduction(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ip25-prod-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = createProductionStore({ runtimeDir });
  const handler = createCommandHandler({ store });
  const created = handler.execute({
    commandId: 'cmd_production_create',
    idempotencyKey: 'key_production_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: { conversationId: 'conv_ip25', packageId: fixture.id },
  }, { actor: 'user', userEventId: 'ue_create' });
  return {
    store,
    handler,
    productionId: created.productionId,
    revision: created.revision,
    context: { actor: 'user', userEventId: 'ue_render' },
  };
}
