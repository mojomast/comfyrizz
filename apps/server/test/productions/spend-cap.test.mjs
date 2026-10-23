// UR19: a user-only command that sets the production spend cap.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { APPROVAL_COMMANDS, createCommandHandler } from '../../src/productions/commands.mjs';
import { createBudgetLedger, ProductionLedgerError } from '../../src/productions/ledger.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';

const AT = '2026-10-23T12:00:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_spend_cap' });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-spend-cap-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function setup(t, contextFor = () => USER) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const ledgerFor = (production) => createBudgetLedger({
    runtimeDir,
    ledgerId: production.budgetLedgerId,
    clock: () => new Date(AT),
  });
  const routes = createProductionRoutes({ store, handler, contextFor, ledgerFor });
  return { runtimeDir, store, handler, routes, ledgerFor };
}

function makeRequest({ method = 'GET', url = '/api/productions', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = {};
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
  return { status: response.statusCode, body, raw: response.body };
}

async function createProduction(routes) {
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: {
      commandId: 'cmd_create',
      idempotencyKey: 'key_create',
      kind: 'production.create',
      payload: { conversationId: 'conv_spend' },
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body;
}

function spendBody(revision, overrides = {}) {
  return {
    ceiling: 1,
    commandId: 'cmd_cap',
    idempotencyKey: 'key_cap',
    expected: { productionRevision: revision },
    ...overrides,
  };
}

test('budget.set_ceiling is an approval command the agent cannot send', () => {
  assert.equal(APPROVAL_COMMANDS.includes('budget.set_ceiling'), true);
});

test('a user request sets the ceiling and a reservation above it is refused', async (t) => {
  const { routes, store, ledgerFor } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const set = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/spend-cap`,
    body: spendBody(created.revision, { ceiling: 1 }),
  });
  assert.equal(set.status, 200, set.raw);
  assert.equal(set.body.ceiling, 1);
  assert.equal(typeof set.body.ledgerRevision, 'number');
  assert.equal(set.body.revision, store.read(id).revision);

  const ledger = ledgerFor(store.read(id));
  assert.equal(ledger.status().ceiling, 1);
  assert.throws(
    () => ledger.reserve({
      reservationId: 'res_over',
      upperBound: 2,
      idempotencyKey: 'reserve_over',
    }),
    (error) => {
      assert.ok(error instanceof ProductionLedgerError);
      assert.equal(error.code, 'BUDGET_EXCEEDED');
      return true;
    },
  );
});

test('an agent actor is refused with 403', async (t) => {
  const { routes } = setup(t, () => ({ actor: 'agent', userEventId: 'ue_agent_cap' }));
  const created = await createProduction(routes);
  const response = await call(routes, {
    method: 'POST',
    url: `/api/productions/${created.productionId}/spend-cap`,
    body: spendBody(created.revision),
  });
  assert.equal(response.status, 403, response.raw);
  assert.equal(response.body.code, 'AGENT_CANNOT_SET_CEILING');
});

test('a retry with the same idempotency key does not append twice', async (t) => {
  const { routes, store, ledgerFor } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const body = spendBody(created.revision, { ceiling: 15 });
  const first = await call(routes, { method: 'POST', url: `/api/productions/${id}/spend-cap`, body });
  assert.equal(first.status, 200, first.raw);
  const second = await call(routes, { method: 'POST', url: `/api/productions/${id}/spend-cap`, body });
  assert.equal(second.status, 200, second.raw);

  const events = store.readEvents(id).filter((event) => event.type === 'budget.ceiling_set');
  assert.equal(events.length, 1);
  const ledger = ledgerFor(store.read(id));
  const authorizations = ledger.entries().filter((entry) => entry.kind === 'authorization');
  assert.equal(authorizations.length, 1);
  assert.equal(ledger.status().ceiling, 15);
  assert.equal(store.read(id).revision, first.body.revision);
});
