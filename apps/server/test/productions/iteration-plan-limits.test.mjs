import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createCommandHandler } from '../../src/productions/commands.mjs';
import { computePlanHash, createActionCoordinator } from '../../src/productions/actions.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';

const AT = '2026-10-23T10:35:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_limits' });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-iteration-plan-limits-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function setup(t) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const ledgers = new Map();
  const ledgerFor = (production) => {
    let ledger = ledgers.get(production.budgetLedgerId);
    if (!ledger) {
      ledger = createBudgetLedger({ runtimeDir, ledgerId: production.budgetLedgerId, clock: () => new Date(AT) });
      ledgers.set(production.budgetLedgerId, ledger);
    }
    return ledger;
  };
  const actions = createActionCoordinator({ store, handler, ledgerFor });
  const routes = createProductionRoutes({ store, handler, actions, contextFor: () => USER });
  return { runtimeDir, store, handler, actions, routes, ledgerFor };
}

function makeRequest(options = {}) {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
  const request = Readable.from(chunks);
  request.method = options.method ?? 'GET';
  request.url = options.url;
  request.headers = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) request.headers[name.toLowerCase()] = value;
  return request;
}

function makeResponse() {
  return {
    statusCode: 0, headers: {}, body: '', headersSent: false,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; },
    end(chunk = '') { if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk); },
    destroy() {},
  };
}

async function call(routes, options = {}) {
  const request = makeRequest(options);
  const response = makeResponse();
  await routes.handle(request, response, options.url);
  let body;
  if (response.body !== '') try { body = JSON.parse(response.body); } catch { body = undefined; }
  return { status: response.statusCode, body, raw: response.body };
}

function slot(id, upperBound, extra = {}) {
  return { id, upperBound, targetId: extra.targetId ?? 'shot_1', effectiveInputHash: `hash_${id}`, seed: 1, ...extra };
}

function planPayload(actions) {
  return {
    planId: 'plan_1',
    revision: 0,
    reservationCeiling: 100,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions,
  };
}

async function createProduction(routes, shotIds = ['shot_1', 'shot_2']) {
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: {
      commandId: 'cmd_create',
      idempotencyKey: 'key_create',
      kind: 'production.create',
      payload: { conversationId: 'conv_1', shotIds },
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body;
}

async function setPolicy(routes, productionId, revision, policy) {
  const response = await call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/commands`,
    body: {
      commandId: 'cmd_iteration',
      idempotencyKey: 'key_iteration',
      kind: 'iteration.set',
      productionId,
      expected: { productionRevision: revision },
      payload: { policy },
    },
  });
  assert.equal(response.status, 200, response.raw);
  return response.body;
}

async function propose(routes, productionId, payload, overrides = {}) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/action-plans`,
    body: {
      commandId: overrides.commandId ?? 'cmd_propose',
      idempotencyKey: overrides.idempotencyKey ?? 'key_propose',
      expected: { productionRevision: overrides.productionRevision ?? 2 },
      payload,
    },
  });
}

test('takes over is refused', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  await setPolicy(routes, created.productionId, created.revision, structuredClone(ITERATION_PRESETS.balanced));
  const rev = store.read(created.productionId).revision;
  const response = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'take', targetId: 'shot_1' }),
    slot('b', 1, { kind: 'take', targetId: 'shot_1' }),
    slot('c', 1, { kind: 'take', targetId: 'shot_1' }),
  ]), { productionRevision: rev });
  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'ITERATION_EXCEEDED');
});

test('rounds over is refused', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  await setPolicy(routes, created.productionId, created.revision, structuredClone(ITERATION_PRESETS.balanced));
  const rev = store.read(created.productionId).revision;
  const response = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'take', targetId: 'shot_1', round: 1 }),
    slot('b', 1, { kind: 'take', targetId: 'shot_1', round: 2 }),
  ]), { productionRevision: rev });
  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'ITERATION_EXCEEDED');
});

test('per-round over is refused', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const policy = structuredClone(ITERATION_PRESETS.director);
  await setPolicy(routes, created.productionId, created.revision, policy);
  const rev = store.read(created.productionId).revision;
  // director video takes 3 per round; 4 in one round exceeds
  const response = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'take', targetId: 'shot_1', round: 1 }),
    slot('b', 1, { kind: 'take', targetId: 'shot_1', round: 1 }),
    slot('c', 1, { kind: 'take', targetId: 'shot_1', round: 1 }),
    slot('d', 1, { kind: 'take', targetId: 'shot_1', round: 1 }),
  ]), { productionRevision: rev });
  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'ITERATION_EXCEEDED');
});

test('audition while auditions off is refused', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  await setPolicy(routes, created.productionId, created.revision, structuredClone(ITERATION_PRESETS.draft));
  const rev = store.read(created.productionId).revision;
  const response = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'audition', targetId: 'shot_1', characterId: 'c1', voice: 'v', line: 'l', engine: 'kokoro' }),
  ]), { productionRevision: rev });
  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'ITERATION_EXCEEDED');
});

test('auditions over per character is refused', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  await setPolicy(routes, created.productionId, created.revision, structuredClone(ITERATION_PRESETS.balanced));
  const rev = store.read(created.productionId).revision;
  const response = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'audition', characterId: 'c1', voice: 'v', line: 'l1', engine: 'kokoro' }),
    slot('b', 1, { kind: 'audition', characterId: 'c1', voice: 'v', line: 'l2', engine: 'kokoro' }),
    slot('c', 1, { kind: 'audition', characterId: 'c1', voice: 'v', line: 'l3', engine: 'kokoro' }),
  ]), { productionRevision: rev });
  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'ITERATION_EXCEEDED');
});

test('per-shot override allows more on one shot', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const policy = structuredClone(ITERATION_PRESETS.balanced);
  policy.shotOverrides = { shot_1: { stages: { video: { takes: 3, rounds: 1, auditions: 0, pick: 'auto' } } } };
  await setPolicy(routes, created.productionId, created.revision, policy);
  const rev = store.read(created.productionId).revision;

  const ok = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'take', targetId: 'shot_1' }),
    slot('b', 1, { kind: 'take', targetId: 'shot_1' }),
    slot('c', 1, { kind: 'take', targetId: 'shot_1' }),
  ]), { productionRevision: rev, commandId: 'cmd_ok', idempotencyKey: 'key_ok' });
  assert.equal(ok.status, 201, ok.raw);

  const bad = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'take', targetId: 'shot_2' }),
    slot('b', 1, { kind: 'take', targetId: 'shot_2' }),
    slot('c', 1, { kind: 'take', targetId: 'shot_2' }),
  ]), { productionRevision: rev, commandId: 'cmd_bad', idempotencyKey: 'key_bad' });
  assert.equal(bad.status, 400, bad.raw);
  assert.equal(bad.body.code, 'ITERATION_EXCEEDED');
});

test('line-id target is counted on its shot', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  await setPolicy(routes, created.productionId, created.revision, structuredClone(ITERATION_PRESETS.balanced));
  const rev = store.read(created.productionId).revision;
  const response = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'take', targetId: 'shot_1:line_1' }),
    slot('b', 1, { kind: 'take', targetId: 'shot_1:line_2' }),
    slot('c', 1, { kind: 'take', targetId: 'shot_1:line_3' }),
  ]), { productionRevision: rev });
  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'ITERATION_EXCEEDED');
});

test('unknown target is INVALID_PLAN', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  await setPolicy(routes, created.productionId, created.revision, structuredClone(ITERATION_PRESETS.balanced));
  const rev = store.read(created.productionId).revision;
  const response = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'take', targetId: 'nope' }),
  ]), { productionRevision: rev });
  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'INVALID_PLAN');
});

test('valid plan accepted with unchanged hash', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  await setPolicy(routes, created.productionId, created.revision, structuredClone(ITERATION_PRESETS.balanced));
  const rev = store.read(created.productionId).revision;
  const payload = planPayload([
    slot('a', 1, { kind: 'take', targetId: 'shot_1' }),
    slot('b', 1, { kind: 'take', targetId: 'shot_2' }),
  ]);
  const response = await propose(routes, created.productionId, payload, { productionRevision: rev });
  assert.equal(response.status, 201, response.raw);
  assert.equal(response.body.planHash, computePlanHash(response.body.plan));
});

test('no policy leaves plan unchanged', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes, ['shot_1']);
  // no iteration.set
  const rev = store.read(created.productionId).revision;
  const response = await propose(routes, created.productionId, planPayload([
    slot('a', 1, { kind: 'take', targetId: 'shot_1' }),
    slot('b', 1, { kind: 'take', targetId: 'shot_1' }),
    slot('c', 1, { kind: 'take', targetId: 'shot_1' }),
    slot('d', 1, { kind: 'take', targetId: 'shot_1' }),
  ]), { productionRevision: rev });
  assert.equal(response.status, 201, response.raw);
});
