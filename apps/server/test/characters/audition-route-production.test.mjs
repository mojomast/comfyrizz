// IP45R: a paid audition is reachable over HTTP through a named production
// action, and the audition acknowledges exactly its own outbox entry.
//
// The route forwards the two exact body fields productionId and actionId; no
// aliases, query-string or header fallback. The real audit worker, production
// store, command handler, action coordinator and ledger run against a temp
// runtime directory. Only the paid synthesizer and the media tickets are fakes.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createCharacterRoutes } from '../../src/characters/routes.mjs';
import {
  AUDITION_ADMISSION_REQUIRED,
  AUDITION_INVALID_INPUT,
  AUDITION_READY,
  ACTION_CONSUMED,
  createAuditionCache,
  createAuditionWorker,
} from '../../src/characters/audition.mjs';
import { canTransition } from '../../src/productions/contract.mjs';
import { createActionCoordinator } from '../../src/productions/actions.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import {
  ProductionStoreError,
  createProductionStore,
  productionPaths,
} from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';

const AT = '2026-10-23T00:08:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_server' });
const LINE = 'Morning! Let us grind.';
const QWEN_VOICE = Object.freeze({
  engine: 'qwen3-tts',
  voice: 'Ryan',
  qwen_mode: 'custom',
  language: 'en-us',
  speed: 1,
  sampleLines: [LINE],
});
const CPU_MODEL = Object.freeze({ id: 'cpu', capabilities: Object.freeze({ supportsNativeVoice: false }) });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-audition-route-production-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
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

function idSource() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return sequence.toString(16).padStart(16, '0');
  };
}

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.status = null;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = { ...headers };
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get body() {
    return Buffer.concat(this.chunks);
  }

  json() {
    return JSON.parse(this.body.toString('utf8'));
  }
}

async function invoke(routes, { method = 'GET', path, headers = {}, body } = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value);
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  request.method = method;
  request.headers = normalized;
  request.url = path;

  const response = new CaptureResponse();
  const finished = new Promise((resolve) => response.on('finish', resolve));
  const matched = await routes.handle(request, response, new URL(path, 'http://127.0.0.1'));
  if (matched) await finished;
  return {
    matched,
    status: response.status,
    headers: response.headers,
    body: response.body,
    json: () => response.json(),
  };
}

function fakeTickets() {
  const minted = [];
  return {
    minted,
    mint(file, options) {
      const ticket = 'f'.repeat(32);
      const record = { ticket, url: `/api/media/${ticket}`, expiresAt: AT, file, options };
      minted.push(record);
      return { ticket, url: record.url, expiresAt: record.expiresAt };
    },
  };
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
  const productionRoutes = createProductionRoutes({ store, handler, actions, contextFor: () => USER });

  const synthCalls = [];
  const workerCalls = [];
  const cache = createAuditionCache({
    rootDir: runtimeDir,
    synth: {
      'qwen3-tts': async (request) => {
        synthCalls.push(request);
        return { bytes: tinyWav('qwen'), usageUnits: 1, started: true };
      },
    },
  });
  const worker = createAuditionWorker({ cache, productionStore: store, ledgerFor });
  const tickets = fakeTickets();
  const characterRoutes = createCharacterRoutes({
    rootDir: runtimeDir,
    clock: () => new Date(AT),
    randomId: idSource(),
    mediaTickets: tickets,
    audition: {
      worker: {
        run(input) {
          workerCalls.push(input);
          return worker.run(input);
        },
      },
      model: CPU_MODEL,
    },
  });

  return {
    runtimeDir,
    store,
    handler,
    actions,
    productionRoutes,
    ledgerFor,
    ledgers,
    cache,
    worker,
    tickets,
    characterRoutes,
    synthCalls,
    workerCalls,
  };
}

async function createCharacter(ctx) {
  const response = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: '/api/characters',
    headers: { 'content-type': 'application/json' },
    body: { name: 'Pip', role: 'mascot', fictional: true, voice: QWEN_VOICE },
  });
  assert.equal(response.status, 201, response.body.toString('utf8'));
  return response.json();
}

function auditionPath(id) {
  return `/api/characters/${id}/audition`;
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

function auditionSlot(characterId, id = 'act_aud', upperBound = 2, overrides = {}) {
  return {
    id,
    upperBound,
    kind: 'audition',
    characterId,
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
    reservationCeiling: 20,
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

async function admitted(ctx, { suffix = 'main', slotsFor = null } = {}) {
  const character = await createCharacter(ctx);
  const productionId = await createProduction(ctx.productionRoutes, `${suffix}_create`);
  const slots = slotsFor ? slotsFor(character.id) : [auditionSlot(character.id)];
  const proposed = await propose(ctx.productionRoutes, productionId, planPayload(slots), `${suffix}_propose`);
  await approvePlan(ctx.productionRoutes, productionId, proposed.plan, `${suffix}_approve`);
  for (const slot of slots) {
    const response = await dispatch(ctx.productionRoutes, productionId, slot.id, `${suffix}_dispatch_${slot.id}`);
    assert.equal(response.status, 202, response.raw);
  }
  return { character, productionId, plan: proposed.plan, slots };
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

function ledgerStatus(ctx, productionId) {
  return ctx.ledgerFor(ctx.store.read(productionId)).status();
}

function settlementEntries(ctx, productionId) {
  return ctx.ledgerFor(ctx.store.read(productionId)).entries().filter((entry) => entry.kind === 'settle');
}

test('IP45R (a): a paid audition without productionId/actionId is 403 and never synthesises', async (t) => {
  const ctx = setup(t);
  const character = await createCharacter(ctx);

  const response = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });

  assert.equal(response.status, 403, response.body.toString('utf8'));
  assert.equal(response.json().ok, false);
  assert.equal(response.json().code, AUDITION_ADMISSION_REQUIRED);
  assert.equal(ctx.workerCalls.length, 1, 'the worker owns the admission decision');
  assert.equal(ctx.synthCalls.length, 0, 'paid synthesis is refused before the runtime is touched');
});

test('IP45R (b): HTTP forwards productionId/actionId and consumes the named slot once', async (t) => {
  const ctx = setup(t);
  const { character, productionId } = await admitted(ctx);

  const response = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE, productionId, actionId: 'act_aud' },
  });

  assert.equal(response.status, 200, response.body.toString('utf8'));
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.code, AUDITION_READY);
  assert.equal(body.engine, 'qwen3-tts');
  assert.match(body.url, /^\/api\/media\/[a-f0-9]{32}$/);
  assert.equal(typeof body.ticket, 'string');
  assert.equal(ctx.synthCalls.length, 1, 'the synthesized wave is generated once');
  assert.equal(ctx.tickets.minted.length, 1, 'the paid success goes through the media ticket');
  assert.equal(fs.existsSync(ctx.tickets.minted[0].file), true);

  const settlements = settlementEntries(ctx, productionId);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].settlementKind, 'actual');
  assert.equal(settlements[0].charged, 1);
  assert.equal(ledgerStatus(ctx, productionId).spent, 1);

  const states = actionStates(ctx.store, productionId);
  assert.equal(states[states.length - 1], 'completed');
  assertLegal(states);
});

test('IP45R (c): another production or a wrong action never lends authority', async (t) => {
  const ctx = setup(t);
  const { character, productionId } = await admitted(ctx);
  const other = await createProduction(ctx.productionRoutes, 'other');

  const crossProduction = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE, productionId: other, actionId: 'act_aud' },
  });
  assert.equal(crossProduction.status, 403, crossProduction.body.toString('utf8'));
  assert.equal(crossProduction.json().code, AUDITION_ADMISSION_REQUIRED);

  const wrongAction = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE, productionId, actionId: 'act_missing' },
  });
  assert.equal(wrongAction.status, 403, wrongAction.body.toString('utf8'));
  assert.equal(wrongAction.json().code, AUDITION_ADMISSION_REQUIRED);

  assert.equal(ctx.synthCalls.length, 0);
  assert.deepEqual(actionStates(ctx.store, productionId), ['queued']);
  const status = ledgerStatus(ctx, productionId);
  assert.equal(status.spent, 0);
  assert.equal(status.openReservations.length, 1, 'production A still owns its reservation');
});

test('IP45R (d): reusing the action over HTTP is 409 ACTION_CONSUMED without a second settlement', async (t) => {
  const ctx = setup(t);
  const { character, productionId } = await admitted(ctx);
  const body = { line: LINE, productionId, actionId: 'act_aud' };

  const first = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(first.status, 200, first.body.toString('utf8'));

  const second = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(second.status, 409, second.body.toString('utf8'));
  assert.equal(second.json().code, ACTION_CONSUMED);
  assert.equal(ctx.synthCalls.length, 1, 'a consumed slot never calls the provider again');
  assert.equal(settlementEntries(ctx, productionId).length, 1);
  assert.equal(ledgerStatus(ctx, productionId).spent, 1);
});

test('IP45R (e): ids must be non-empty strings and alias/query spellings are ignored', async (t) => {
  const ctx = setup(t);
  const { character, productionId } = await admitted(ctx);

  const invalid = [
    { line: LINE, productionId: 7, actionId: 'act_aud' },
    { line: LINE, productionId: { id: productionId }, actionId: 'act_aud' },
    { line: LINE, productionId: '', actionId: 'act_aud' },
    { line: LINE, productionId, actionId: 7 },
    { line: LINE, productionId, actionId: ['act_aud'] },
    { line: LINE, productionId, actionId: '' },
  ];
  for (const body of invalid) {
    const response = await invoke(ctx.characterRoutes, {
      method: 'POST',
      path: auditionPath(character.id),
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(response.status, 400, `${JSON.stringify(body)} -> ${response.status} ${response.body}`);
    assert.equal(response.json().ok, false);
    assert.equal(response.json().code, AUDITION_INVALID_INPUT);
  }
  assert.equal(ctx.workerCalls.length, 0, 'invalid ids are refused before the worker is called');
  assert.equal(ctx.synthCalls.length, 0);

  const aliasBody = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE, production_id: productionId, action_id: 'act_aud' },
  });
  assert.equal(aliasBody.status, 403, aliasBody.body.toString('utf8'));
  assert.equal(aliasBody.json().code, AUDITION_ADMISSION_REQUIRED);

  const queryString = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: `${auditionPath(character.id)}?productionId=${productionId}&actionId=act_aud`,
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });
  assert.equal(queryString.status, 403, queryString.body.toString('utf8'));
  assert.equal(queryString.json().code, AUDITION_ADMISSION_REQUIRED);

  assert.equal(ctx.synthCalls.length, 0);
  assert.deepEqual(actionStates(ctx.store, productionId), ['queued']);
});

function makeProduction(id = 'prod_ack', overrides = {}) {
  return {
    schema: 'comfyrizz.production/v1',
    id,
    revision: 0,
    conversationId: `conv_${id}`,
    packageId: null,
    intent: 'active',
    briefVersionId: null,
    scriptVersionId: null,
    shotIds: [],
    characterBindings: [],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: `ledger_${id}`,
    pendingDecisionIds: [],
    actionIds: [],
    latestDeliveryId: null,
    lastSequence: 0,
    ...overrides,
  };
}

function outboxEntry(id, actionId) {
  return { id, type: 'action.dispatch', payload: { actionId } };
}

test('IP45R (f): acknowledgeOutboxEntry acknowledges exactly one committed entry', async (t) => {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const production = makeProduction();
  store.create(production);
  store.commit(production.id, {
    commandId: 'cmd_outbox',
    idempotencyKey: 'cmd_outbox',
    baseRevision: 0,
    events: [],
    outbox: [outboxEntry('ob_first', 'act_first'), outboxEntry('ob_second', 'act_second')],
  });

  assert.deepEqual(store.pending(production.id).map((entry) => entry.id), ['ob_first', 'ob_second']);

  const paths = productionPaths(runtimeDir, production.id);
  const firstAck = join(paths.outbox, 'ob_first.ack');
  const firstPending = join(paths.outbox, 'ob_first.json');
  const secondPending = join(paths.outbox, 'ob_second.json');
  assert.equal(fs.existsSync(firstPending), true);

  assert.deepEqual(store.acknowledgeOutboxEntry({ productionId: production.id, outboxId: 'ob_first' }), {
    id: 'ob_first',
    acknowledged: true,
  });
  assert.deepEqual(store.pending(production.id).map((entry) => entry.id), ['ob_second']);
  assert.equal(fs.existsSync(firstAck), true);
  assert.equal(fs.existsSync(firstPending), false);
  assert.equal(fs.existsSync(secondPending), true, 'the other entry is untouched');
  const ack = JSON.parse(fs.readFileSync(firstAck, 'utf8'));
  assert.equal(ack.id, 'ob_first');
  assert.equal(typeof ack.at, 'string');
  assert.ok(Number.isSafeInteger(ack.attempts));

  const ackBytes = fs.readFileSync(firstAck, 'utf8');
  assert.deepEqual(store.acknowledgeOutboxEntry({ productionId: production.id, outboxId: 'ob_first' }), {
    id: 'ob_first',
    acknowledged: false,
    reason: 'ALREADY_ACKNOWLEDGED',
  });
  assert.equal(fs.readFileSync(firstAck, 'utf8'), ackBytes, 'a repeat writes nothing');

  assert.throws(
    () => store.acknowledgeOutboxEntry({ productionId: production.id, outboxId: 'ob_missing' }),
    (error) => error instanceof ProductionStoreError && error.code === 'OUTBOX_NOT_FOUND',
  );
  assert.throws(
    () => store.acknowledgeOutboxEntry({ productionId: 'prod_unknown', outboxId: 'ob_first' }),
    (error) => error instanceof ProductionStoreError && error.code === 'NOT_FOUND',
  );
  assert.throws(
    () => store.acknowledgeOutboxEntry(production.id, 'ob_first'),
    (error) => error instanceof ProductionStoreError && error.code === 'INVALID_INPUT',
  );

  const recovered = store.recover(production.id);
  assert.deepEqual(recovered.pending.map((entry) => entry.id), ['ob_second']);
  assert.equal(fs.existsSync(firstPending), false, 'recovery never rematerialises an acknowledged entry');
  assert.equal(store.acknowledgeOutboxEntry({ productionId: production.id, outboxId: 'ob_first' }).reason, 'ALREADY_ACKNOWLEDGED');

  const published = [];
  const drained = await store.drainOutbox(production.id, (entry) => published.push(entry.id));
  assert.deepEqual(published, ['ob_second'], 'drainOutbox publishes only the unacknowledged entry');
  assert.equal(drained.published, 1);
  assert.deepEqual(store.pending(production.id), []);
});

test('IP45R (g): an audition acknowledges its own outbox entry while another stays pending', async (t) => {
  const ctx = setup(t);
  const { character, productionId } = await admitted(ctx, {
    slotsFor: (characterId) => [
      auditionSlot(characterId, 'act_aud'),
      auditionSlot(characterId, 'act_second'),
    ],
  });
  assert.equal(ctx.store.pending(productionId).length, 2, 'both dispatches are pending');

  const pendingBefore = ctx.store.pending(productionId);
  assert.deepEqual(pendingBefore.map((entry) => entry.payload.actionId), ['act_aud', 'act_second']);
  const otherId = pendingBefore.find((entry) => entry.payload.actionId === 'act_second').id;

  const response = await invoke(ctx.characterRoutes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE, productionId, actionId: 'act_aud' },
  });
  assert.equal(response.status, 200, response.body.toString('utf8'));

  const pendingAfter = ctx.store.pending(productionId);
  assert.deepEqual(pendingAfter.map((entry) => entry.payload.actionId), ['act_second']);
  const paths = productionPaths(ctx.runtimeDir, productionId);
  assert.equal(fs.existsSync(join(paths.outbox, `${otherId}.ack`)), false, 'the other entry was never published');
  assert.equal(fs.existsSync(join(paths.outbox, `${otherId}.json`)), true, 'the other entry is still pending');
  assert.equal(settlementEntries(ctx, productionId).length, 1);
});
