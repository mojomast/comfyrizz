// IP45K: a paid audition must consume an approved, dispatched IP20 slot.
//
// The free Kokoro route never needs an action. A paid/native engine is admitted
// only by a queued slot of kind 'audition' on the named production, claims it
// through the legal action state machine, and settles the real production
// ledger exactly once. A slot in another production is never ambient authority.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createAuditionCache, createAuditionWorker } from '../../src/characters/audition.mjs';
import { canTransition } from '../../src/productions/contract.mjs';
import { createActionCoordinator } from '../../src/productions/actions.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';

const AT = '2026-10-23T00:08:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_server' });
const LINE = 'Morning! Let us grind.';
const CHARACTER_ID = 'chr_0123456789abcdef';
const QWEN_VOICE = Object.freeze({
  engine: 'qwen3-tts',
  voice: 'Ryan',
  qwen_mode: 'custom',
  language: 'en-us',
  speed: 1,
  sampleLines: [LINE],
});

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-audition-action-'));
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

function makeRequest({ method = 'GET', url = '/api/productions', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
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
  await routes.handle(request, response, options.url);
  let body;
  try { body = JSON.parse(response.body); } catch { body = undefined; }
  return { status: response.statusCode, headers: response.headers, body, raw: response.body };
}

async function createProduction(routes, suffix = 'create') {
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: {
      commandId: `cmd_${suffix}`,
      idempotencyKey: `key_${suffix}`,
      kind: 'production.create',
      payload: { conversationId: 'conv_1' },
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body.productionId;
}

function auditionSlot(id = 'act_aud', upperBound = 2, overrides = {}) {
  return {
    id,
    upperBound,
    kind: 'audition',
    characterId: CHARACTER_ID,
    voice: QWEN_VOICE.voice,
    line: LINE,
    engine: QWEN_VOICE.engine,
    ...overrides,
  };
}

function planPayload(actions, requiredDecisions = []) {
  return {
    planId: 'plan_1',
    revision: 0,
    reservationCeiling: 5,
    collectAndStopReserve: 0,
    requiredDecisions,
    actions,
  };
}

async function propose(routes, productionId, payload, suffix = 'propose') {
  const response = await call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/action-plans`,
    body: {
      commandId: `cmd_${suffix}`,
      idempotencyKey: `key_${suffix}`,
      expected: { productionRevision: 1 },
      payload,
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body;
}

async function command(routes, productionId, kind, revision, payload, suffix) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/commands`,
    body: {
      commandId: `cmd_${suffix}`,
      idempotencyKey: `key_${suffix}`,
      kind,
      productionId,
      expected: { productionRevision: revision },
      payload,
    },
  });
}

async function approvePlan(routes, productionId, plan, suffix = 'approve') {
  const production = await call(routes, { method: 'GET', url: `/api/productions/${productionId}` });
  const set = await command(routes, productionId, 'iteration.set', production.body.production.revision, {
    policy: structuredClone(ITERATION_PRESETS.balanced),
  }, `${suffix}_iteration`);
  assert.equal(set.status, 200, set.raw);
  const response = await command(routes, productionId, 'plan.approve', set.body.production.revision, {
    planId: plan.id,
    planHash: plan.planHash,
  }, suffix);
  assert.equal(response.status, 200, response.raw);
}

async function dispatch(routes, productionId, actionId = 'act_aud', suffix = 'dispatch') {
  const production = await call(routes, { method: 'GET', url: `/api/productions/${productionId}` });
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/actions`,
    body: {
      commandId: `cmd_${suffix}`,
      idempotencyKey: `key_${suffix}`,
      expected: { productionRevision: production.body.production.revision },
      payload: { planId: 'plan_1', planRevision: 0, actionId },
    },
  });
}

function tinyWav(label = 'qwen') {
  const data = Buffer.from(label, 'utf8');
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

function workerFor(runtimeDir, { synth, ledgerFor, store }) {
  const cache = createAuditionCache({ rootDir: runtimeDir, synth });
  return createAuditionWorker({ cache, productionStore: store, ledgerFor });
}

function actionStates(store, productionId, actionId = 'act_aud') {
  return store.readEvents(productionId)
    .filter((event) => event.type === 'action.state_changed' && event.data?.id === actionId)
    .map((event) => event.data.state);
}

function assertLegal(states) {
  assert.ok(states.length >= 2, `expected a state path, got ${states.join(' > ')}`);
  for (let index = 1; index < states.length; index += 1) {
    assert.equal(
      canTransition(states[index - 1], states[index]),
      true,
      `illegal action transition ${states[index - 1]} -> ${states[index]} (${states.join(' > ')})`,
    );
  }
}

function ledgerStatus(runtimeDir, production) {
  return createBudgetLedger({
    runtimeDir,
    ledgerId: production.budgetLedgerId,
    clock: () => new Date(AT),
  }).status();
}

async function admitted(t, overrides = {}) {
  const ctx = setup(t);
  const id = await createProduction(ctx.routes);
  const proposed = await propose(ctx.routes, id, planPayload([auditionSlot('act_aud', 2, overrides.slot ?? {})]));
  await approvePlan(ctx.routes, id, proposed.plan);
  const dispatched = await dispatch(ctx.routes, id);
  assert.equal(dispatched.status, 202, dispatched.raw);
  return { ...ctx, id, plan: proposed.plan, action: dispatched.body.action };
}

test('IP45K: a paid audition without a production action is 403 and never synthesises', async (t) => {
  const { runtimeDir, store, ledgerFor } = setup(t);
  const calls = [];
  const worker = workerFor(runtimeDir, {
    store,
    ledgerFor,
    synth: { 'qwen3-tts': async () => { calls.push(1); return tinyWav(); } },
  });

  const result = await worker.run({
    character: { id: CHARACTER_ID, voice: QWEN_VOICE },
    voice: QWEN_VOICE,
    line: LINE,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUDITION_ADMISSION_REQUIRED');
  assert.equal(calls.length, 0);
});

test('IP45K: a dispatched slot with no mounted paid synth is 503, stays queued and charges nothing', async (t) => {
  const { runtimeDir, store, ledgerFor, id } = await admitted(t);
  const calls = [];

  const worker = workerFor(runtimeDir, {
    store,
    ledgerFor,
    synth: { kokoro: async () => { calls.push(1); return tinyWav(); } },
  });

  const result = await worker.run({
    character: { id: CHARACTER_ID, voice: QWEN_VOICE },
    voice: QWEN_VOICE,
    line: LINE,
    productionId: id,
    actionId: 'act_aud',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUDITION_UNAVAILABLE');
  assert.equal(calls.length, 0);
  assert.deepEqual(actionStates(store, id), ['queued'], 'the slot is not claimed');
  const status = ledgerStatus(runtimeDir, store.read(id));
  assert.equal(status.spent, 0);
  assert.equal(status.openReservations.length, 1, 'the reservation stays open');
});

test('IP45K: a measured success settles actual units once and walks the legal states', async (t) => {
  const { runtimeDir, store, ledgerFor, id } = await admitted(t);
  const dispatchEntry = store.pending(id).find((entry) => entry.payload?.actionId === 'act_aud');
  assert.equal(dispatchEntry.payload.kind, 'audition');
  assert.deepEqual(dispatchEntry.payload.audition, {
    characterId: CHARACTER_ID,
    voice: QWEN_VOICE.voice,
    line: LINE,
    engine: QWEN_VOICE.engine,
  });
  const calls = [];
  const worker = workerFor(runtimeDir, {
    store,
    ledgerFor,
    synth: {
      'qwen3-tts': async () => {
        calls.push(1);
        return { bytes: tinyWav('qwen'), usageUnits: 1, started: true };
      },
    },
  });

  const result = await worker.run({
    character: { id: CHARACTER_ID, voice: QWEN_VOICE },
    voice: QWEN_VOICE,
    line: LINE,
    productionId: id,
    actionId: 'act_aud',
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  const states = actionStates(store, id);
  assert.deepEqual(states, ['queued', 'dispatching', 'running', 'collecting', 'verifying', 'completed']);
  assertLegal(states);

  const status = ledgerStatus(runtimeDir, store.read(id));
  assert.equal(status.spent, 1);
  assert.equal(status.openReservations.length, 0);
  assert.equal(status.committed, 0);
  const ledger = ledgerFor(store.read(id));
  const settlement = ledger.entries().find((entry) => entry.kind === 'settle');
  assert.equal(settlement.settlementKind, 'actual');
  assert.equal(settlement.charged, 1);

  const pending = store.pending(id).filter((entry) => entry.payload?.actionId === 'act_aud');
  assert.deepEqual(pending, [], 'the action outbox entry is acknowledged');

  const replay = await worker.run({
    character: { id: CHARACTER_ID, voice: QWEN_VOICE },
    voice: QWEN_VOICE,
    line: LINE,
    productionId: id,
    actionId: 'act_aud',
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'ACTION_CONSUMED');
  assert.equal(calls.length, 1, 'a consumed slot never calls the provider again');
  assert.equal(ledgerStatus(runtimeDir, store.read(id)).spent, 1, 'spend is settled exactly once');
});

test('IP45K: success without a measured usage is recorded as reservation_unverified', async (t) => {
  const { runtimeDir, store, ledgerFor, id } = await admitted(t);
  const worker = workerFor(runtimeDir, {
    store,
    ledgerFor,
    synth: { 'qwen3-tts': async () => ({ bytes: tinyWav('unmeasured'), started: true }) },
  });

  const result = await worker.run({
    character: { id: CHARACTER_ID, voice: QWEN_VOICE },
    voice: QWEN_VOICE,
    line: LINE,
    productionId: id,
    actionId: 'act_aud',
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const status = ledgerStatus(runtimeDir, store.read(id));
  assert.equal(status.spent, 2, 'the full hold is charged but marked unverified');
  const settlement = ledgerFor(store.read(id)).entries().find((entry) => entry.kind === 'settle');
  assert.equal(settlement.settlementKind, 'reservation_unverified');
});

test('IP45K: a failure after the provider started walks to failed and holds the reservation', async (t) => {
  const { runtimeDir, store, ledgerFor, id } = await admitted(t);
  const worker = workerFor(runtimeDir, {
    store,
    ledgerFor,
    synth: {
      'qwen3-tts': async () => ({ ok: false, code: 'QWEN_PROVIDER_FAILED', started: true, message: 'provider failed' }),
    },
  });

  const result = await worker.run({
    character: { id: CHARACTER_ID, voice: QWEN_VOICE },
    voice: QWEN_VOICE,
    line: LINE,
    productionId: id,
    actionId: 'act_aud',
  });

  assert.equal(result.ok, false);
  const states = actionStates(store, id);
  assert.deepEqual(states, ['queued', 'dispatching', 'running', 'failed']);
  assertLegal(states);
  const status = ledgerStatus(runtimeDir, store.read(id));
  assert.equal(status.spent, 2, 'unknown post-start usage settles the full hold');
  const settlement = ledgerFor(store.read(id)).entries().find((entry) => entry.kind === 'settle');
  assert.equal(settlement.settlementKind, 'reservation_unverified');
});

test('IP45K: a failure before allocation settles no_allocation and charges zero', async (t) => {
  const { runtimeDir, store, ledgerFor, id } = await admitted(t);
  const worker = workerFor(runtimeDir, {
    store,
    ledgerFor,
    synth: {
      'qwen3-tts': async () => ({ ok: false, code: 'AUDITION_UNAVAILABLE', started: false, message: 'runtime missing' }),
    },
  });

  const result = await worker.run({
    character: { id: CHARACTER_ID, voice: QWEN_VOICE },
    voice: QWEN_VOICE,
    line: LINE,
    productionId: id,
    actionId: 'act_aud',
  });

  assert.equal(result.ok, false);
  const states = actionStates(store, id);
  assertLegal(states);
  const status = ledgerStatus(runtimeDir, store.read(id));
  assert.equal(status.spent, 0);
  assert.equal(status.openReservations.length, 0);
  const settlement = ledgerFor(store.read(id)).entries().find((entry) => entry.kind === 'settle');
  assert.equal(settlement.settlementKind, 'no_allocation');
});

test('IP45K: a slot in production A is not ambient authority for production B or an anonymous request', async (t) => {
  const ctx = await admitted(t);
  const other = await createProduction(ctx.routes, 'create_other');
  const calls = [];
  const worker = workerFor(ctx.runtimeDir, {
    store: ctx.store,
    ledgerFor: ctx.ledgerFor,
    synth: { 'qwen3-tts': async () => { calls.push(1); return { bytes: tinyWav('qwen'), usageUnits: 1, started: true }; } },
  });

  for (const input of [
    { productionId: other, actionId: 'act_aud' },
    { productionId: ctx.id, actionId: undefined },
    { productionId: undefined, actionId: 'act_aud' },
  ]) {
    const result = await worker.run({
      character: { id: CHARACTER_ID, voice: QWEN_VOICE },
      voice: QWEN_VOICE,
      line: LINE,
      ...input,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AUDITION_ADMISSION_REQUIRED');
  }

  assert.equal(calls.length, 0);
  assert.deepEqual(actionStates(ctx.store, ctx.id), ['queued'], 'production A still owns its slot');
  assert.equal(ledgerStatus(ctx.runtimeDir, ctx.store.read(ctx.id)).spent, 0);
});

test('IP45K: a mismatched slot payload is not admitted', async (t) => {
  const ctx = await admitted(t, { slot: { line: 'A different line.' } });
  const calls = [];
  const worker = workerFor(ctx.runtimeDir, {
    store: ctx.store,
    ledgerFor: ctx.ledgerFor,
    synth: { 'qwen3-tts': async () => { calls.push(1); return { bytes: tinyWav(), usageUnits: 1, started: true }; } },
  });

  const result = await worker.run({
    character: { id: CHARACTER_ID, voice: QWEN_VOICE },
    voice: QWEN_VOICE,
    line: LINE,
    productionId: ctx.id,
    actionId: 'act_aud',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUDITION_ADMISSION_REQUIRED');
  assert.equal(calls.length, 0);
  assert.deepEqual(actionStates(ctx.store, ctx.id), ['queued']);
});

test('IP45K: a rejected required decision never dispatches and the audition is 403', async (t) => {
  const ctx = setup(t);
  const id = await createProduction(ctx.routes);
  const proposed = await propose(
    ctx.routes,
    id,
    planPayload([auditionSlot()], [{ kind: 'voice_selection', decisionId: 'dec_voice' }]),
  );
  await approvePlan(ctx.routes, id, proposed.plan);

  const production = await call(ctx.routes, { method: 'GET', url: `/api/productions/${id}` });
  const rejected = await command(
    ctx.routes,
    id,
    'decision.resolve',
    production.body.production.revision,
    { decisionId: 'dec_voice', optionId: 'reject' },
    'resolve_reject',
  );
  assert.equal(rejected.status, 200, rejected.raw);

  const refused = await dispatch(ctx.routes, id, 'act_aud', 'dispatch_rejected');
  assert.equal(refused.status, 409, refused.raw);
  assert.equal(refused.body.code, 'DECISION_REQUIRED');
  assert.deepEqual(ctx.store.read(id).actionIds, []);

  const calls = [];
  const worker = workerFor(ctx.runtimeDir, {
    store: ctx.store,
    ledgerFor: ctx.ledgerFor,
    synth: { 'qwen3-tts': async () => { calls.push(1); return { bytes: tinyWav(), usageUnits: 1, started: true }; } },
  });
  const result = await worker.run({
    character: { id: CHARACTER_ID, voice: QWEN_VOICE },
    voice: QWEN_VOICE,
    line: LINE,
    productionId: id,
    actionId: 'act_aud',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUDITION_ADMISSION_REQUIRED');
  assert.equal(calls.length, 0);
  assert.deepEqual(ledgerStatus(ctx.runtimeDir, ctx.store.read(id)).openReservations, []);
});
