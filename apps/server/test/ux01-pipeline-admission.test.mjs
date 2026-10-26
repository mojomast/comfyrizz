// UX01: `/api/pipeline` admission on the real mounted app. A package bound to a
// production starts the full pipeline only through the server-owned dispatch
// path (the pipeline adapter, which journals the action before it starts the
// worker). A browser request to the route cannot. The launcher is a fake that
// counts: Google Colab and external backends are never reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createApp } from '../src/app.mjs';
import { createPipelineController } from '../src/pipeline.mjs';
import { createPipelineAdapter } from '../src/productions/pipeline-adapter.mjs';
import { validateAdmissionRefusal, ADMISSION_REFUSALS } from '../src/productions/contract.mjs';
import { cleanup, makeBoundProduction, tempRuntime, ACTION_ID } from './ux01-fixture.mjs';

const TOKEN = 'ux01-pipeline-token-0123456789';

function onePackage() {
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url)));
  pkg.scenes = [pkg.scenes[0]];
  delete pkg.scenes[0].transitionOut;
  pkg.scenes[0].background = null;
  pkg.scenes[0].foreground = [];
  pkg.assets = {};
  return pkg;
}

async function mount(t, { runtimeDir = tempRuntime(t), bound = null } = {}) {
  const launches = [];
  const backendRequests = [];
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    pipelineLaunch: (specPath, onMessage, onExit) => {
      launches.push({ specPath, onMessage, onExit });
      return { cancel() {} };
    },
    backendFactory: async (backendId) => { backendRequests.push(backendId); return null; },
    fakeBackend: false,
    providers: { available: [] },
  });
  const pkg = onePackage();
  app.store.seed(pkg);
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, async () => { app.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { origin: base, 'x-comfyrizz-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: response.status, json, text };
  };
  return {
    app, pkg, launches, backendRequests, post,
    body: { packageId: pkg.id, baseRevision: pkg.revision, backendId: 'cpu' },
    bound,
  };
}

function assertRefusal(response, code) {
  assert.equal(response.json?.code, code, response.text);
  assert.equal(response.status, ADMISSION_REFUSALS[code], response.text);
  assert.deepEqual(validateAdmissionRefusal(response.json), { ok: true, errors: [] }, response.text);
  assert.equal(response.json.run, undefined, 'a refusal never carries a run');
}

async function boundMount(t, intent = 'active') {
  const pkg = onePackage();
  const ctx = makeBoundProduction(t, { packageId: pkg.id });
  const env = await mount(t, { runtimeDir: ctx.runtimeDir });
  if (intent === 'paused') ctx.command('production.pause');
  if (intent === 'cancel_requested') ctx.command('production.cancel');
  if (intent === 'archived') ctx.command('production.archive');
  return { ...env, ctx };
}

test('UX01: an unbound package still starts through /api/pipeline', async t => {
  const env = await mount(t);
  const started = await env.post('/api/pipeline', env.body);
  assert.equal(started.status, 202, started.text);
  assert.equal(env.launches.length, 1);
});

for (const [intent, code] of [['active', 'BOUND_AUTHORITY_REQUIRED'], ['paused', 'PRODUCTION_NOT_ACTIVE'], ['cancel_requested', 'PRODUCTION_NOT_ACTIVE'], ['archived', 'PRODUCTION_NOT_ACTIVE']]) {
  test(`UX01: /api/pipeline refuses a bound ${intent} production with ${code} and launches nothing`, async t => {
    const env = await boundMount(t, intent);
    const refused = await env.post('/api/pipeline', env.body);
    assertRefusal(refused, code);
    if (code === 'PRODUCTION_NOT_ACTIVE') assert.equal(refused.json.intent, intent);
    assert.equal(env.launches.length, 0);
    assert.deepEqual(env.backendRequests, []);
    assert.equal(env.app.pipelines.list().length, 0, 'no run record was created');
    assert.equal(env.ctx.action().state, 'queued', 'the dispatched action is untouched');
  });
}

test('UX01: /api/pipeline cannot be given authority by the request body', async t => {
  const env = await boundMount(t);
  for (const extra of [
    { approved: true },
    { approvedPlanHash: env.ctx.planHash },
    { authority: env.ctx.authority(), expected: { productionRevision: env.ctx.revision() } },
    { origin: { productionId: env.ctx.productionId, actionId: ACTION_ID } },
  ]) {
    const refused = await env.post('/api/pipeline', { ...env.body, ...extra });
    assert.ok(refused.status >= 400, refused.text);
    assert.ok(['BOUND_AUTHORITY_REQUIRED', 'BOUND_ENTRY_UNSUPPORTED'].includes(refused.json?.code), refused.text);
    assert.equal(env.launches.length, 0);
  }
  assert.equal(env.ctx.action().state, 'queued');
});

test('UX01: an inline package that names another production is refused as PRODUCTION_MISMATCH', async t => {
  const env = await boundMount(t);
  const sourceDir = dirname(env.app.store.path(env.pkg.id));
  const refused = await env.app.pipelines.start({ ...env.app.store.read(env.pkg.id), productionId: 'prod_someone_else' }, env.body, sourceDir);
  assert.equal(refused.code, 'PRODUCTION_MISMATCH', JSON.stringify(refused));
  assert.equal(refused.status, 403);
  assert.deepEqual(validateAdmissionRefusal(refused), { ok: true, errors: [] });
  assert.equal(env.launches.length, 0);
});

test('UX01: the server-owned dispatch path starts one pipeline run for one action, and a repeat cannot start a second', async t => {
  const env = await boundMount(t);
  const adapter = createPipelineAdapter({ store: env.ctx.store, controller: env.app.pipelines });
  const sourceDir = dirname(env.app.store.path(env.pkg.id));
  const args = { productionId: env.ctx.productionId, actionId: ACTION_ID, pkg: env.app.store.read(env.pkg.id), input: env.body, sourceDir };
  const first = await adapter.admit(args);
  assert.equal(first.started, true, JSON.stringify(first));
  assert.equal(env.launches.length, 1);
  const again = await adapter.admit(args);
  assert.equal(env.launches.length, 1, 'a repeated admit adopts the attributed run');
  assert.equal(again.duplicate, true);

  // Even a direct repeat on the controller refuses: one action, one allocation.
  const direct = await env.app.pipelines.start(env.app.store.read(env.pkg.id), env.body, sourceDir, {
    origin: { productionId: env.ctx.productionId, actionId: ACTION_ID },
  });
  assert.equal(direct.code, 'DUPLICATE_START', JSON.stringify(direct));
  assert.equal(direct.status, 409);
  assert.equal(env.launches.length, 1);
});

test('UX01: the dispatch path refuses an action that was never journaled as dispatching', async t => {
  const env = await boundMount(t);
  const sourceDir = dirname(env.app.store.path(env.pkg.id));
  const origin = { productionId: env.ctx.productionId, actionId: ACTION_ID };
  const queued = await env.app.pipelines.start(env.app.store.read(env.pkg.id), env.body, sourceDir, { origin });
  assert.equal(queued.code, 'ACTION_NOT_ADMITTED', JSON.stringify(queued));
  const unknown = await env.app.pipelines.start(env.app.store.read(env.pkg.id), env.body, sourceDir, { origin: { ...origin, actionId: 'act_nope' } });
  assert.equal(unknown.code, 'UNKNOWN_ACTION');
  const foreign = await env.app.pipelines.start(env.app.store.read(env.pkg.id), env.body, sourceDir, { origin: { ...origin, productionId: 'prod_other' } });
  assert.equal(foreign.code, 'PRODUCTION_MISMATCH');
  assert.equal(env.launches.length, 0);
});

test('UX01: a production paused while inputs are being staged does not launch the worker', async t => {
  const pkg = onePackage();
  const ctx = makeBoundProduction(t, { packageId: pkg.id });
  const launches = [];
  const controller = createPipelineController({
    runtimeDir: ctx.runtimeDir,
    stageInputs: async () => { ctx.command('production.pause'); },
    launch: (specPath) => { launches.push(specPath); return { cancel() {} }; },
    ownerHeartbeatMs: 0,
  });
  cleanup(t, () => controller.close());
  const adapter = createPipelineAdapter({ store: ctx.store, controller });
  const result = await adapter.admit({
    productionId: ctx.productionId, actionId: ACTION_ID, pkg, input: { packageId: pkg.id, baseRevision: pkg.revision, backendId: 'cpu' }, sourceDir: ctx.runtimeDir,
  });
  assert.equal(result.started, false, JSON.stringify(result));
  assert.equal(launches.length, 0, 'the worker was never launched');
  assert.equal(controller.list().length, 0, 'no run record is left behind');
  assert.equal(controller.active(), false, 'the shared slot is free again');
});
