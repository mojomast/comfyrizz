// UX21F: the mounted app's command boundary is the only place a committed
// production event can wake the outbox executor.
//
// R1: production.cancel must fan out to the run that action.dispatch started,
// and an action.cancel command must have its durable outbox entry acknowledged
// by the same commit, without waiting for an unrelated dispatch.
// R3: a plan slot without backendId/upperBound is refused with a typed reason
// instead of fabricating Google Colab defaults.
//
// The pipeline launcher is a fake that counts; no backend is reached, no
// Google Colab VM is started and nothing touches the network beyond loopback.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.mjs';
import { ITERATION_PRESETS } from '../src/productions/iteration.mjs';
import { createProductionStore } from '../src/productions/store.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';

const TOKEN = 'ux21f-app-mounts-token-0123456789';
const SCENE_ID = 's_title';

function tempRuntime() {
  return mkdtempSync(join(tmpdir(), 'comfyrizz-ux21f-'));
}

function onePackage() {
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url)));
  pkg.scenes = [pkg.scenes[0]];
  delete pkg.scenes[0].transitionOut;
  pkg.scenes[0].background = null;
  pkg.scenes[0].foreground = [];
  pkg.assets = {};
  return pkg;
}

function waitFor(check, { timeout = 3000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try {
        value = check();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for the expected app state'));
        return;
      }
      setTimeout(poll, interval);
    };
    poll();
  });
}

async function mount(t, runtimeDir) {
  const launches = [];
  const cancels = [];
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    pipelineLaunch: (specPath) => {
      const handle = { specPath, cancel: () => { cancels.push(specPath); }, kill: () => {} };
      launches.push(handle);
      return handle;
    },
    backendFactory: async () => null,
    fakeBackend: false,
    providers: { available: [] },
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: { origin: base, 'x-comfyrizz-token': TOKEN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep text for the assertion */ }
    return { status: response.status, json, text };
  };
  return { app, launches, cancels, call };
}

async function createProduction(env, pkg, suffix) {
  collectMockContribution(pkg, env.app.store.dir);
  env.app.store.write(pkg);
  const created = await env.call('POST', '/api/productions', {
    commandId: `cmd_create_${suffix}`,
    idempotencyKey: `key_create_${suffix}`,
    kind: 'production.create',
    payload: { conversationId: `conv_${suffix}`, packageId: pkg.id, shotIds: [SCENE_ID] },
  });
  assert.equal(created.status, 201, created.text);
  const productionId = created.json.productionId;
  const iteration = await env.call('POST', `/api/productions/${productionId}/commands`, {
    commandId: `cmd_iteration_${suffix}`,
    idempotencyKey: `key_iteration_${suffix}`,
    kind: 'iteration.set',
    expected: { productionRevision: env.store.read(productionId).revision },
    payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
  });
  assert.equal(iteration.status, 200, iteration.text);
  return productionId;
}

async function proposeAndApprove(env, productionId, suffix, slotExtra = {}) {
  const proposed = await env.call('POST', `/api/productions/${productionId}/action-plans`, {
    commandId: `cmd_plan_${suffix}`,
    idempotencyKey: `key_plan_${suffix}`,
    expected: { productionRevision: env.store.read(productionId).revision },
    payload: {
      planId: `plan_${suffix}`,
      revision: 0,
      reservationCeiling: 5,
      collectAndStopReserve: 0,
      requiredDecisions: [],
      actions: [{
        id: `act_${suffix}`,
        kind: 'take',
        targetId: SCENE_ID,
        assetId: 'a_plate',
        upperBound: 2,
        effectiveInputHash: `hash_${suffix}`,
        seed: 1,
        ...slotExtra,
      }],
    },
  });
  assert.equal(proposed.status, 201, proposed.text);
  const approved = await env.call('POST', `/api/productions/${productionId}/commands`, {
    commandId: `cmd_approve_${suffix}`,
    idempotencyKey: `key_approve_${suffix}`,
    kind: 'plan.approve',
    expected: { productionRevision: env.store.read(productionId).revision },
    payload: { planId: proposed.json.plan.id, planHash: proposed.json.planHash },
  });
  assert.equal(approved.status, 200, approved.text);
  return proposed.json.plan;
}

async function dispatch(env, productionId, suffix) {
  return env.call('POST', `/api/productions/${productionId}/actions`, {
    commandId: `cmd_dispatch_${suffix}`,
    idempotencyKey: `key_dispatch_${suffix}`,
    expected: { productionRevision: env.store.read(productionId).revision },
    payload: { planId: `plan_${suffix}`, planRevision: 0, actionId: `act_${suffix}` },
  });
}

async function command(env, productionId, suffix, kind, payload) {
  return env.call('POST', `/api/productions/${productionId}/commands`, {
    commandId: `cmd_${suffix}`,
    idempotencyKey: `key_${suffix}`,
    kind,
    expected: { productionRevision: env.store.read(productionId).revision },
    payload,
  });
}

test('UX21F R1: production.cancel stops the run started by one dispatched slot', async (t) => {
  const runtimeDir = tempRuntime();
  const env = await mount(t, runtimeDir);
  env.store = createProductionStore({ runtimeDir });
  const pkg = onePackage();
  env.app.store.seed(pkg);

  const productionId = await createProduction(env, pkg, 'prod_cancel');
  await proposeAndApprove(env, productionId, 'prod_cancel', { backendId: 'cpu' });
  const dispatched = await dispatch(env, productionId, 'prod_cancel');
  assert.equal(dispatched.status, 202, dispatched.text);
  await waitFor(() => env.launches.length === 1);
  assert.equal(env.launches.length, 1, 'one dispatched slot starts exactly one pipeline run');

  const cancelled = await command(env, productionId, 'cancel_prod', 'production.cancel', {});
  assert.equal(cancelled.status, 200, cancelled.text);

  await waitFor(() => env.cancels.length > 0);
  assert.equal(env.cancels.length, 1, 'production.cancel reaches the run without a further dispatch');
  assert.equal(env.launches.length, 1, 'the cancel command starts nothing');
});

test('UX21F R1: action.cancel acknowledges its outbox entry immediately', async (t) => {
  const runtimeDir = tempRuntime();
  const env = await mount(t, runtimeDir);
  env.store = createProductionStore({ runtimeDir });
  const pkg = onePackage();
  env.app.store.seed(pkg);

  const productionId = await createProduction(env, pkg, 'prod_action_cancel');
  await proposeAndApprove(env, productionId, 'prod_action_cancel', { backendId: 'cpu' });
  const dispatched = await dispatch(env, productionId, 'prod_action_cancel');
  assert.equal(dispatched.status, 202, dispatched.text);
  await waitFor(() => env.launches.length === 1);

  const cancelled = await command(env, productionId, 'cancel_action', 'action.cancel', {
    actionId: 'act_prod_action_cancel',
  });
  assert.equal(cancelled.status, 200, cancelled.text);

  await waitFor(() => !env.store.pending(productionId).some(entry => entry.type === 'action.cancel'));
  assert.equal(env.store.pending(productionId).filter(entry => entry.type === 'action.cancel').length, 0,
    'the same commit drains and acknowledges the action.cancel entry');
  await waitFor(() => env.cancels.length > 0);
  assert.equal(env.launches.length, 1, 'cancelling does not dispatch another run');
});

test('UX21F R3: an incomplete plan slot is refused instead of defaulting to Google Colab', async (t) => {
  const runtimeDir = tempRuntime();
  const env = await mount(t, runtimeDir);
  env.store = createProductionStore({ runtimeDir });
  const pkg = onePackage();
  env.app.store.seed(pkg);

  const productionId = await createProduction(env, pkg, 'prod_incomplete');
  await proposeAndApprove(env, productionId, 'prod_incomplete');
  const dispatched = await dispatch(env, productionId, 'prod_incomplete');
  assert.equal(dispatched.status, 202, dispatched.text);

  await waitFor(() => env.app.events.readAfter(0).events.some(event => event.type === 'production.execution_error'
    && event.productionId === productionId
    && event.code === 'SLOT_INCOMPLETE'));
  assert.equal(env.launches.length, 0, 'no backend is started without a complete approved slot');
});

test('UX21F2 R1: action.cancel drains the cancelled action, not the latest slot', async (t) => {
  const runtimeDir = tempRuntime();
  const env = await mount(t, runtimeDir);
  env.store = createProductionStore({ runtimeDir });
  const pkg = onePackage();
  env.app.store.seed(pkg);

  const productionId = await createProduction(env, pkg, 'prod_cancel_latest');
  await proposeAndApprove(env, productionId, 'prod_cancel_latest', { backendId: 'cpu' });
  const dispatched = await dispatch(env, productionId, 'prod_cancel_latest');
  assert.equal(dispatched.status, 202, dispatched.text);
  await waitFor(() => env.launches.length === 1);

  // A newer slot is dispatched with no backendId, so it is the latest action
  // in the journal while its dispatch drain is refused SLOT_INCOMPLETE.
  await proposeAndApprove(env, productionId, 'prod_cancel_newer', { upperBound: 2 });
  const newerDispatched = await dispatch(env, productionId, 'prod_cancel_newer');
  assert.equal(newerDispatched.status, 202, newerDispatched.text);
  await waitFor(() => env.app.events.readAfter(0).events.some(event => event.type === 'production.execution_error'
    && event.productionId === productionId
    && event.code === 'SLOT_INCOMPLETE'));
  assert.equal(env.launches.length, 1, 'the incomplete newer slot starts nothing');

  const cancelled = await command(env, productionId, 'cancel_older', 'action.cancel', {
    actionId: 'act_prod_cancel_latest',
  });
  assert.equal(cancelled.status, 200, cancelled.text);

  await waitFor(() => !env.store.pending(productionId).some(entry => entry.type === 'action.cancel'));
  assert.equal(env.launches.length, 1, 'the cancel commit does not start the pending incomplete dispatch');
  assert.ok(env.store.pending(productionId).some(entry => entry.type === 'action.dispatch'
    && entry.payload?.actionId === 'act_prod_cancel_newer'),
  'a cancel commit never consumes the pending dispatch of another slot');
  await waitFor(() => env.cancels.length > 0);
  assert.deepEqual(env.cancels, [env.launches[0].specPath],
    'the fake controller cancels the run of the action named by the command payload');
});

test('UX21F2 R1: action.cancel is acknowledged even when its slot is SLOT_INCOMPLETE', async (t) => {
  const runtimeDir = tempRuntime();
  const env = await mount(t, runtimeDir);
  env.store = createProductionStore({ runtimeDir });
  const pkg = onePackage();
  env.app.store.seed(pkg);

  const productionId = await createProduction(env, pkg, 'prod_cancel_incomplete');
  await proposeAndApprove(env, productionId, 'prod_cancel_incomplete');
  const dispatched = await dispatch(env, productionId, 'prod_cancel_incomplete');
  assert.equal(dispatched.status, 202, dispatched.text);

  await waitFor(() => env.app.events.readAfter(0).events.some(event => event.type === 'production.execution_error'
    && event.productionId === productionId
    && event.code === 'SLOT_INCOMPLETE'));
  assert.equal(env.launches.length, 0, 'the incomplete slot starts no Google Colab or pipeline work');

  const cancelled = await command(env, productionId, 'cancel_incomplete', 'action.cancel', {
    actionId: 'act_prod_cancel_incomplete',
  });
  assert.equal(cancelled.status, 200, cancelled.text);

  await waitFor(() => !env.store.pending(productionId).some(entry => entry.type === 'action.cancel'));
  assert.equal(env.store.pending(productionId).filter(entry => entry.type === 'action.cancel').length, 0,
    'the refused dispatch context does not leave the cancel entry pending');
  assert.equal(env.launches.length, 0, 'cancelling an incomplete slot starts no pipeline work');
});
