// SPW05: Chatterbox multilingual narration reaches the production action plan.
//
// The character voice contract and the plan-time narration slot check must
// accept the Chatterbox engine name without changing the Kokoro default or
// widening the closed engine vocabulary to unknown values.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { CHATTERBOX_ENGINE } from '../../../../packages/tts/voices.mjs';
import { VOICE_ENGINES } from '../../src/characters/model.mjs';
import { createActionCoordinator } from '../../src/productions/actions.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';

const AT = '2026-10-30T21:05:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_server' });
const CHARACTER_ID = 'chr_0123456789abcdef';
const LINE = 'Every language gets a voice.';

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-chatterbox-'));
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
  return { runtimeDir, store, handler, actions, routes };
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
  if (response.body !== '') {
    try { body = JSON.parse(response.body); } catch { body = undefined; }
  }
  return { status: response.statusCode, headers: response.headers, body, raw: response.body };
}

async function createProduction(routes) {
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: {
      commandId: 'cmd_create',
      idempotencyKey: 'key_create',
      kind: 'production.create',
      payload: { conversationId: 'conv_chatterbox' },
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body.productionId;
}

function narrationSlot(engine) {
  return {
    id: 'act_aud',
    upperBound: 2,
    kind: 'audition',
    characterId: CHARACTER_ID,
    voice: 'en',
    line: LINE,
    engine,
  };
}

function planPayload(engine) {
  return {
    planId: 'plan_chatterbox',
    revision: 0,
    reservationCeiling: 5,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions: [narrationSlot(engine)],
  };
}

function propose(routes, productionId, engine) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/action-plans`,
    body: {
      commandId: 'cmd_propose',
      idempotencyKey: 'key_propose',
      expected: { productionRevision: 1 },
      payload: planPayload(engine),
    },
  });
}

test('SPW05: VOICE_ENGINES includes Chatterbox and keeps Kokoro the default', () => {
  assert.equal(CHATTERBOX_ENGINE, 'chatterbox');
  assert.ok(VOICE_ENGINES.includes(CHATTERBOX_ENGINE));
  assert.equal(VOICE_ENGINES[0], 'kokoro');
});

test('SPW05: an action plan accepts a Chatterbox narration slot', async (t) => {
  const { routes } = setup(t);
  const productionId = await createProduction(routes);

  const response = await propose(routes, productionId, CHATTERBOX_ENGINE);

  assert.equal(response.status, 201, response.raw);
  assert.equal(response.body.plan.actions[0].engine, CHATTERBOX_ENGINE);
});

test('SPW05: an unknown narration engine is still rejected', async (t) => {
  const { routes, store } = setup(t);
  const productionId = await createProduction(routes);

  const response = await propose(routes, productionId, 'mystery-tts');

  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'INVALID_PLAN');
  assert.match(response.body.error, /must be kokoro, qwen3-tts or chatterbox/);
  assert.equal(store.readEvents(productionId).some((event) => event.type === 'plan.proposed'), false);
});
