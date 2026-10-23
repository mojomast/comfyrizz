// IL04F: paid plan.approve is gated on an iteration level.
//
// A plan with any slot that can reserve spend (upperBound > 0, except a free
// local Kokoro audition) cannot be approved until production.iteration exists.
// The gate fails closed on kind-less, unknown-kind and backendId-claimed slots.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCommandHandler } from '../../src/productions/commands.mjs';
import {
  computePlanHash,
  createActionCoordinator,
} from '../../src/productions/actions.mjs';
import { createBudgetLedger, ledgerPaths } from '../../src/productions/ledger.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import {
  createProductionRoutes,
} from '../../src/routes/productions.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';

const AT = '2026-10-23T10:35:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_server' });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-iteration-gate-'));
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
      ledger = createBudgetLedger({
        runtimeDir,
        ledgerId: production.budgetLedgerId,
        clock: () => new Date(AT),
      });
      ledgers.set(production.budgetLedgerId, ledger);
    }
    return ledger;
  };
  const actions = createActionCoordinator({ store, handler, ledgerFor });
  const routes = createProductionRoutes({ store, handler, actions, contextFor: () => USER });
  return { runtimeDir, store, handler, actions, routes, ledgerFor, ledgers };
}

function slot(id, upperBound, extra = {}) {
  return { id, upperBound, targetId: `shot_${id}`, effectiveInputHash: `hash_${id}`, seed: 1, ...extra };
}

function planPayload(overrides = {}) {
  const { actions: planActions, ...rest } = overrides;
  return {
    planId: 'plan_1',
    revision: 0,
    reservationCeiling: 5,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions: planActions === undefined ? [slot('act_1', 2)] : planActions,
    ...rest,
  };
}

function envelope(commandId, payload, overrides = {}) {
  return {
    commandId,
    idempotencyKey: `key_${commandId}`,
    expected: { productionRevision: overrides.productionRevision ?? 1 },
    payload,
    ...overrides,
    payload,
  };
}

async function createProduction(routes, overrides = {}) {
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: {
      commandId: 'cmd_create',
      idempotencyKey: 'key_create',
      kind: 'production.create',
      payload: { conversationId: 'conv_1', ...overrides },
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body;
}

async function call(routes, options = {}) {
  // reuse makeRequest style by importing? implement minimal via routes.handle
  const { createServer } = await import('node:http');
  void createServer;
  const { Readable } = await import('node:stream');
  const request = Readable.from(options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]);
  request.method = options.method ?? 'GET';
  request.url = options.url;
  request.headers = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    request.headers[name.toLowerCase()] = value;
  }
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; },
    end(chunk = '') { if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk); },
    destroy() {},
  };
  const handled = await routes.handle(request, response, options.url);
  let body;
  if (response.body !== '') {
    try { body = JSON.parse(response.body); } catch { body = undefined; }
  }
  return { handled, status: response.statusCode, headers: response.headers, body, raw: response.body };
}

async function propose(routes, productionId, payload, overrides = {}) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/action-plans`,
    headers: overrides.headers,
    body: envelope(overrides.commandId ?? 'cmd_propose', payload, {
      expected: { productionRevision: overrides.productionRevision ?? 1 },
      ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
    }),
  });
}

async function approve(routes, productionId, payload, productionRevision) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/commands`,
    body: {
      commandId: `cmd_approve_${payload.planHash ?? 'none'}_${productionRevision}`,
      idempotencyKey: `key_approve_${payload.planHash ?? 'none'}_${productionRevision}`,
      kind: 'plan.approve',
      productionId,
      expected: { productionRevision },
      payload,
    },
  });
}

async function command(routes, productionId, kind, productionRevision, extra = {}) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/commands`,
    body: {
      commandId: extra.commandId ?? `cmd_${kind.replaceAll('.', '_')}_${productionRevision}`,
      idempotencyKey: extra.idempotencyKey ?? `key_${kind.replaceAll('.', '_')}_${productionRevision}`,
      kind,
      productionId,
      expected: { productionRevision },
      payload: extra.payload ?? {},
    },
  });
}

function setBalanced(routes, productionId, productionRevision) {
  return command(routes, productionId, 'iteration.set', productionRevision, {
    payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
  });
}

test('paid plans return 409 ITERATION_LEVEL_REQUIRED until a level is set', async (t) => {
  const variants = [
    { name: 'kind-less slot upperBound 2', actions: [slot('act_paid', 2)] },
    { name: 'render', actions: [slot('act_render', 2, { kind: 'render' })] },
    { name: 'take', actions: [slot('act_take', 2, { kind: 'take' })] },
    { name: 'native_take', actions: [slot('act_native', 2, { kind: 'native_take' })] },
    { name: 'audition qwen3-tts', actions: [slot('act_q', 2, { kind: 'audition', characterId: 'c1', voice: 'v', line: 'l', engine: 'qwen3-tts' })] },
    { name: 'unknown kind keyframe', actions: [slot('act_key', 2, { kind: 'keyframe' })] },
    { name: 'render backendId cpu', actions: [slot('act_cpu', 2, { kind: 'render', backendId: 'cpu' })] },
  ];

  for (const variant of variants) {
    const { routes, store, runtimeDir } = setup(t);
    const created = await createProduction(routes);
    const id = created.productionId;
    const proposed = await propose(routes, id, planPayload({ actions: variant.actions }));
    assert.equal(proposed.status, 201, `${variant.name}: ${proposed.raw}`);
    const revisionBefore = store.read(id).revision;
    const refused = await approve(routes, id, { planId: 'plan_1', planHash: proposed.body.planHash }, revisionBefore);
    assert.equal(refused.status, 409, `${variant.name}: ${refused.raw}`);
    assert.equal(refused.body.code, 'ITERATION_LEVEL_REQUIRED', variant.name);
    assert.equal(store.read(id).revision, revisionBefore, variant.name);
    assert.equal(store.readEvents(id).filter((event) => event.type === 'plan.approved').length, 0, variant.name);
    assert.equal(fs.existsSync(ledgerPaths(runtimeDir, created.production.budgetLedgerId).file), false, variant.name);
  }
});

test('a paid plan approves after iteration.set (Balanced)', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const proposed = await propose(routes, id, planPayload({ actions: [slot('act_1', 2)] }));
  assert.equal(proposed.status, 201, proposed.raw);
  const set = await setBalanced(routes, id, store.read(id).revision);
  assert.equal(set.status, 200, set.raw);
  const approved = await approve(routes, id, { planId: 'plan_1', planHash: proposed.body.planHash }, store.read(id).revision);
  assert.equal(approved.status, 200, approved.raw);
  assert.equal(store.readEvents(id).filter((event) => event.type === 'plan.approved').length, 1);
});

test('free plans approve without a level', async (t) => {
  // actions []
  {
    const { routes, store } = setup(t);
    const created = await createProduction(routes);
    const id = created.productionId;
    const proposed = await propose(routes, id, planPayload({ actions: [] }));
    assert.equal(proposed.status, 201, proposed.raw);
    const approved = await approve(routes, id, { planId: 'plan_1', planHash: proposed.body.planHash }, store.read(id).revision);
    assert.equal(approved.status, 200, approved.raw);
  }
  // kokoro audition
  {
    const { routes, store } = setup(t);
    const created = await createProduction(routes);
    const id = created.productionId;
    const proposed = await propose(routes, id, planPayload({
      actions: [slot('act_k', 2, { kind: 'audition', characterId: 'c1', voice: 'v', line: 'l', engine: 'kokoro' })],
    }));
    assert.equal(proposed.status, 201, proposed.raw);
    const approved = await approve(routes, id, { planId: 'plan_1', planHash: proposed.body.planHash }, store.read(id).revision);
    assert.equal(approved.status, 200, approved.raw);
  }
  // upperBound 0
  {
    const { routes, store } = setup(t);
    const created = await createProduction(routes);
    const id = created.productionId;
    const proposed = await propose(routes, id, planPayload({ actions: [slot('act_z', 0)] }));
    assert.equal(proposed.status, 201, proposed.raw);
    const approved = await approve(routes, id, { planId: 'plan_1', planHash: proposed.body.planHash }, store.read(id).revision);
    assert.equal(approved.status, 200, approved.raw);
  }
});
