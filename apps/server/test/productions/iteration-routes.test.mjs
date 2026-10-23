// IL08: the iteration read route.
//
// GET /api/productions/:id/iteration returns the durable policy (when set),
// the three preset estimates and the custom estimate (only for a custom
// policy), the pure recommendation, the preference pre-fill, the locked shots
// and the production revision. The route is read-only: iteration.set still
// goes through POST /api/productions/:id/commands.
//
// These tests use an in-memory request/response pair and temporary runtime
// directories. There are no network, backend or Google Colab calls.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createApp } from '../../src/app.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import {
  ITERATION_PRESETS,
  validateIterationPolicy,
} from '../../src/productions/iteration.mjs';
import { createIterationRoutes } from '../../src/productions/iteration-routes.mjs';
import { createPreferencesStore } from '../../src/productions/preferences.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';

const AT = '2026-10-23T12:30:00.000Z';
const POLICY_KEY = 'iteration.policy';

function clone(value) {
  return structuredClone(value);
}

function policy(level) {
  return validateIterationPolicy(clone(ITERATION_PRESETS[level]));
}

function customPolicy() {
  const base = clone(ITERATION_PRESETS.director);
  base.shotOverrides = { shot_1: { stages: { video: { takes: 1 } } } };
  return validateIterationPolicy(base);
}

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-iteration-routes-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeProduction(overrides = {}) {
  return {
    schema: 'comfyrizz.production/v1',
    id: 'prod_1',
    revision: 3,
    conversationId: 'conv_1',
    packageId: null,
    intent: 'active',
    briefVersionId: null,
    scriptVersionId: null,
    shotIds: ['shot_1', 'shot_2', 'shot_3'],
    characterBindings: [],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: 'ledger_1',
    pendingDecisionIds: [],
    actionIds: [],
    latestDeliveryId: null,
    lastSequence: 3,
    ...overrides,
  };
}

function fakeStore(production, events = []) {
  return {
    read(id) {
      return id === production.id ? clone(production) : null;
    },
    readEvents(id) {
      assert.equal(id, production.id);
      return clone(events);
    },
  };
}

function fakePreferences(data = {}) {
  return {
    expose(target) {
      return { data: clone(data), prompt: '', fingerprint: 'test', overrides: [], target };
    },
  };
}

function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = {};
  for (const [name, value] of Object.entries(headers)) request.headers[name.toLowerCase()] = value;
  return request;
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(chunk = '') {
      if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    },
    destroy() {},
  };
}

async function call(routes, options = {}) {
  const request = makeRequest(options);
  const response = makeResponse();
  const handled = await routes.handle(request, response, options.url);
  let body;
  if (response.body !== '') {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = undefined;
    }
  }
  return { handled, status: response.statusCode, headers: response.headers, body, raw: response.body };
}

function assertEstimate(estimate) {
  for (const key of ['gpuMinutes', 'units', 'wallMinutes']) {
    for (const edge of ['low', 'expected', 'high']) {
      assert.equal(typeof estimate[key][edge], 'number', `${key}.${edge}`);
      assert.ok(Number.isFinite(estimate[key][edge]), `${key}.${edge} finite`);
    }
    assert.ok(estimate[key].low <= estimate[key].expected, `${key}: low <= expected`);
    assert.ok(estimate[key].expected <= estimate[key].high, `${key}: expected <= high`);
  }
  assert.ok(Array.isArray(estimate.labels));
}

test('GET returns the three preset estimates, a recommendation and the revision', async (t) => {
  const production = makeProduction();
  const routes = createIterationRoutes({
    store: fakeStore(production),
    preferences: fakePreferences(),
  });

  const response = await call(routes, {
    url: '/api/productions/prod_1/iteration?durationSeconds=30',
  });

  assert.equal(response.handled, true);
  assert.equal(response.status, 200, response.raw);
  assert.equal(response.body.policy, null);
  assert.equal(response.body.level, null);
  assert.equal(response.body.revision, 3);
  assert.deepEqual(Object.keys(response.body.estimates), ['draft', 'balanced', 'director']);
  for (const level of ['draft', 'balanced', 'director']) {
    assertEstimate(response.body.estimates[level]);
  }
  // The production has no characters; the route must not force a minimum of one.
  assert.equal(response.body.estimates.balanced.voiceSamples, 0);
  assert.equal(response.body.recommendation.level, 'balanced');
  assert.deepEqual(response.body.recommendation.policy, policy('balanced'));
  assert.ok(response.body.recommendation.reasons.length > 0);
  assert.equal(response.body.prefill, null);
  assert.deepEqual(response.body.lockedShotIds, []);
});

test('a stored custom policy is validated and adds the custom estimate only', async (t) => {
  const stored = customPolicy();
  const production = makeProduction({
    iteration: { policy: stored, level: stored.level, setAt: AT, revision: 3 },
  });
  const routes = createIterationRoutes({
    store: fakeStore(production),
    preferences: fakePreferences(),
  });

  const response = await call(routes, {
    url: '/api/productions/prod_1/iteration?durationSeconds=30',
  });

  assert.equal(response.status, 200, response.raw);
  assert.deepEqual(response.body.policy, stored);
  assert.equal(response.body.level, 'custom');
  assert.deepEqual(Object.keys(response.body.estimates), ['draft', 'balanced', 'director', 'custom']);
  assertEstimate(response.body.estimates.custom);
  // The custom estimate comes from the stored policy, so the shot_1 video
  // override (one take instead of director's three) must make it cheaper.
  assert.ok(
    response.body.estimates.custom.units.expected
      < response.body.estimates.director.units.expected,
  );
});

test('a stored policy that fails validation is a 500 with the coded error', async (t) => {
  const broken = clone(ITERATION_PRESETS.balanced);
  broken.stages.video.takes = 99;
  const production = makeProduction({ iteration: { policy: broken, level: 'balanced', revision: 3 } });
  const routes = createIterationRoutes({
    store: fakeStore(production),
    preferences: fakePreferences(),
  });

  const response = await call(routes, {
    url: '/api/productions/prod_1/iteration?durationSeconds=30',
  });

  assert.equal(response.status, 500, response.raw);
  assert.equal(response.body.code, 'ITERATION_EXCEEDED');
  assert.equal(response.body.estimates, undefined);
});

test('prefill resolves the project preference over the user preference', async (t) => {
  const runtimeDir = tempRuntime(t);
  const preferences = createPreferencesStore({ runtimeDir, clock: () => new Date(AT) });
  preferences.set({
    scope: 'user',
    key: POLICY_KEY,
    value: policy('balanced'),
    actor: 'user',
    userEventId: 'ue_user_pref',
    commandId: 'cmd_user_pref',
  });
  preferences.set({
    scope: 'project',
    scopeId: 'pkg_1',
    key: POLICY_KEY,
    value: policy('director'),
    actor: 'user',
    userEventId: 'ue_project_pref',
    commandId: 'cmd_project_pref',
  });

  const withProject = createIterationRoutes({
    store: fakeStore(makeProduction({ packageId: 'pkg_1' })),
    preferences,
  });
  const projectResponse = await call(withProject, {
    url: '/api/productions/prod_1/iteration?durationSeconds=30',
  });
  assert.equal(projectResponse.status, 200, projectResponse.raw);
  assert.equal(projectResponse.body.prefill.level, 'director');

  const userOnly = createIterationRoutes({
    store: fakeStore(makeProduction({ packageId: null })),
    preferences,
  });
  const userResponse = await call(userOnly, {
    url: '/api/productions/prod_1/iteration?durationSeconds=30',
  });
  assert.equal(userResponse.status, 200, userResponse.raw);
  assert.equal(userResponse.body.prefill.level, 'balanced');
});

test('lockedShotIds lists the shots locked by actions and take requests', async (t) => {
  const events = [
    { type: 'action.state_changed', data: { id: 'act_1', state: 'queued', shotId: 'shot_1' } },
    { type: 'action.state_changed', data: { id: 'act_1', state: 'cancelled', shotId: 'shot_1' } },
    { type: 'action.state_changed', data: { id: 'act_2', state: 'running', shotId: 'shot_2' } },
    { type: 'take.requested', data: { shotId: 'shot_3', stage: 'video' } },
  ];
  const routes = createIterationRoutes({
    store: fakeStore(makeProduction(), events),
    preferences: fakePreferences(),
  });

  const response = await call(routes, {
    url: '/api/productions/prod_1/iteration?durationSeconds=30',
  });

  assert.equal(response.status, 200, response.raw);
  assert.deepEqual(response.body.lockedShotIds, ['shot_2', 'shot_3']);
});

test('non-GET methods are 405 and a read never writes', async (t) => {
  let commits = 0;
  let preferenceWrites = 0;
  const store = {
    ...fakeStore(makeProduction()),
    commit() {
      commits += 1;
      throw new Error('the iteration read must not commit');
    },
  };
  const preferences = {
    ...fakePreferences(),
    set() { preferenceWrites += 1; throw new Error('the iteration read must not write preferences'); },
    correct() { preferenceWrites += 1; throw new Error('the iteration read must not write preferences'); },
    revoke() { preferenceWrites += 1; throw new Error('the iteration read must not write preferences'); },
  };
  const routes = createIterationRoutes({ store, preferences });

  const post = await call(routes, {
    method: 'POST',
    url: '/api/productions/prod_1/iteration',
    body: { policy: policy('director') },
  });
  assert.equal(post.handled, true);
  assert.equal(post.status, 405);

  const get = await call(routes, {
    url: '/api/productions/prod_1/iteration?durationSeconds=30',
  });
  assert.equal(get.status, 200, get.raw);
  assert.equal(commits, 0);
  assert.equal(preferenceWrites, 0);
});

test('durationSeconds must be a finite number >= 0 when supplied', async (t) => {
  const routes = createIterationRoutes({
    store: fakeStore(makeProduction()),
    preferences: fakePreferences(),
  });

  for (const value of ['-1', 'not-a-number', 'Infinity']) {
    const response = await call(routes, {
      url: `/api/productions/prod_1/iteration?durationSeconds=${value}`,
    });
    assert.equal(response.status, 400, `${value}: ${response.raw}`);
    assert.equal(response.body.code, 'INVALID_DURATION_SECONDS', value);
  }
});

test('the production routes do not answer the iteration path first', async (t) => {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  t.after(() => store.close?.());
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const productionRoutes = createProductionRoutes({
    store,
    handler,
    contextFor: () => ({ actor: 'user', userEventId: 'ue_route' }),
  });

  const response = await call(productionRoutes, {
    url: '/api/productions/prod_1/iteration?durationSeconds=30',
  });
  assert.equal(response.handled, false);
  assert.equal(response.status, 0);

  const iterationRoutes = createIterationRoutes({
    store: fakeStore(makeProduction()),
    preferences: fakePreferences(),
  });
  const handled = await call(iterationRoutes, {
    url: '/api/productions/prod_1/iteration?durationSeconds=30',
  });
  assert.equal(handled.handled, true);
  assert.equal(handled.status, 200, handled.raw);
});

async function http({ port, method = 'GET', path, token, body, origin }) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { host: `127.0.0.1:${port}` };
  if (token) headers['x-comfyrizz-token'] = token;
  if (origin) headers.origin = origin;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('the app mounts GET /api/productions/:id/iteration before the production facade', async (t) => {
  const runtimeDir = tempRuntime(t);
  const token = 'iteration-routes-token-0123456789';
  const preferences = createPreferencesStore({ runtimeDir, clock: () => new Date(AT) });
  preferences.set({
    scope: 'user',
    key: POLICY_KEY,
    value: policy('director'),
    actor: 'user',
    userEventId: 'ue_app_pref',
    commandId: 'cmd_app_pref',
  });

  const app = createApp({ token, runtimeDir });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    app.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const created = await http({
    port,
    method: 'POST',
    path: '/api/productions',
    token,
    origin,
    body: {
      commandId: 'cmd_create_iteration_routes',
      idempotencyKey: 'key_create_iteration_routes',
      kind: 'production.create',
      payload: { conversationId: 'conv_app', shotIds: ['shot_1', 'shot_2'] },
    },
  });
  assert.equal(created.status, 201, created.text);
  const productionId = created.json.productionId;
  const productionRevision = created.json.revision;

  const set = await http({
    port,
    method: 'POST',
    path: `/api/productions/${productionId}/commands`,
    token,
    origin,
    body: {
      commandId: 'cmd_set_iteration_routes',
      idempotencyKey: 'key_set_iteration_routes',
      kind: 'iteration.set',
      productionId,
      expected: { productionRevision },
      payload: { policy: policy('balanced') },
    },
  });
  assert.equal(set.status, 200, set.text);

  const read = await http({
    port,
    path: `/api/productions/${productionId}/iteration?durationSeconds=30`,
    token,
    origin,
  });
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(Object.keys(read.json.estimates), ['draft', 'balanced', 'director']);
  assert.equal(read.json.level, 'balanced');
  assert.deepEqual(read.json.policy, policy('balanced'));
  assert.equal(read.json.prefill.level, 'director');
  assert.deepEqual(read.json.lockedShotIds, []);
  assert.equal(typeof read.json.revision, 'number');
  assert.ok(read.json.recommendation.level);

  const unauthorized = await http({
    port,
    path: `/api/productions/${productionId}/iteration?durationSeconds=30`,
    origin,
  });
  assert.equal(unauthorized.status, 401, unauthorized.text);
});
