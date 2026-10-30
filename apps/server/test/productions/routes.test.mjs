// IP19: the /api/productions HTTP facade.
//
// The facade must stay thin over IP18's command handler and IP17's store:
// attribution comes only from the injected server context, the URL id is
// authoritative, POST bodies are the command envelope, and every read has one
// documented shape. The tests drive the routes over an in-memory request /
// response pair; no backend, network or real Google Colab session is used.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createProductionStore, productionPaths } from '../../src/productions/store.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import {
  MAX_BODY_BYTES,
  PRODUCTION_ROUTE_PATTERN,
  createProductionRoutes,
} from '../../src/routes/productions.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const USER_CONTEXT = Object.freeze({ actor: 'user', userEventId: 'ue_server' });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-prod-routes-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function setup(t, contextFor = () => USER_CONTEXT) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const routes = createProductionRoutes({ store, handler, contextFor });
  return { runtimeDir, store, handler, routes };
}

function makeRequest({ method = 'GET', url = '/api/productions', headers = {}, body } = {}) {
  const chunks = body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = {};
  for (const [name, value] of Object.entries(headers)) {
    request.headers[name.toLowerCase()] = value;
  }
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

function createEnvelope(overrides = {}) {
  return {
    commandId: 'cmd_create',
    idempotencyKey: 'key_create',
    kind: 'production.create',
    payload: { conversationId: 'conv_1', briefVersionId: 'brief_1' },
    ...overrides,
  };
}

test('invite productions reject caller-authored plans and non-Colab easy plans', async (t) => {
  const { store, handler } = setup(t);
  const routes = createProductionRoutes({
    store, handler,
    contextFor: () => ({ ...USER_CONTEXT, inviteId: 'invite_1' }),
    inviteOwnership: { assertAccess() {} },
    actions: { propose() { throw new Error('untrusted plan reached coordinator'); } },
    readPackage: () => null,
  });
  const forged = await call(routes, { method: 'POST', url: '/api/productions/prod_1/action-plans', body: {} });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, 'INVITE_SERVER_PLAN_REQUIRED');
  const cpu = await call(routes, { method: 'POST', url: '/api/productions/prod_1/easy-plan', body: { level: 'draft', compute: 'cpu' } });
  assert.equal(cpu.status, 403);
  assert.equal(cpu.body.code, 'INVITE_COLAB_ONLY');
  const forgedAction = await call(routes, { method: 'POST', url: '/api/productions/prod_1/commands', body: { kind: 'action.dispatch', payload: { id: 'act_fake', state: 'queued' } } });
  assert.equal(forgedAction.status, 403);
  assert.equal(forgedAction.body.code, 'INVITE_COMMAND_FORBIDDEN');
});

function commandEnvelope(kind, productionId, overrides = {}) {
  const slug = kind.replaceAll('.', '_');
  return {
    commandId: `cmd_${slug}`,
    idempotencyKey: `key_${slug}`,
    kind,
    expected: { productionRevision: 1 },
    payload: { note: 'test' },
    ...(productionId === undefined ? {} : { productionId }),
    ...overrides,
  };
}

async function createProduction(routes, overrides = {}, callOptions = {}) {
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: createEnvelope(overrides),
    ...callOptions,
  });
  assert.equal(response.status, 201, response.raw);
  return response.body;
}

function journalPath(runtimeDir, productionId) {
  return productionPaths(runtimeDir, productionId).events;
}

function removeJournalLine(runtimeDir, productionId, index) {
  const file = journalPath(runtimeDir, productionId);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
  lines.splice(index, 1);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

test('create is server-attributed, idempotent and returns 201 then 200', async (t) => {
  const { routes } = setup(t);

  const created = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    headers: {
      'x-comfyrizz-actor': 'agent',
      'x-comfyrizz-user-event-id': 'ue_forged',
    },
    body: createEnvelope(),
  });

  assert.equal(created.handled, true);
  assert.equal(created.status, 201);
  assert.equal(created.body.duplicate, false);
  assert.match(created.body.productionId, /^prod_/);
  assert.equal(created.body.production.id, created.body.productionId);
  assert.equal(created.body.production.revision, 1);
  // Headers are never attribution; contextFor supplied both values.
  assert.equal(created.body.command.actor, 'user');
  assert.equal(created.body.command.userEventId, 'ue_server');
  assert.equal(created.body.command.productionId, created.body.productionId);

  const replay = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: createEnvelope({ expected: { productionRevision: 0 } }),
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.productionId, created.body.productionId);
});

test('GET snapshot returns production, revision and lastSequence only', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);

  const snapshot = await call(routes, {
    method: 'GET',
    url: `/api/productions/${created.productionId}`,
  });

  assert.equal(snapshot.status, 200);
  assert.deepEqual(Object.keys(snapshot.body).sort(), ['lastSequence', 'production', 'revision']);
  assert.equal(snapshot.body.production.id, created.productionId);
  assert.equal(snapshot.body.revision, 1);
  assert.equal(snapshot.body.lastSequence, 1);
  assert.equal('cards' in snapshot.body, false);

  const missing = await call(routes, { method: 'GET', url: '/api/productions/prod_missing' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');
});

test('GET events returns the replay shape and ignores Last-Event-ID', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const proposed = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: commandEnvelope('plan.propose', id),
  });
  assert.equal(proposed.status, 200, proposed.raw);

  const replay = await call(routes, {
    method: 'GET',
    url: `/api/productions/${id}/events?after=0&lastEventId=99`,
    headers: { 'x-last-event-id': '99', 'last-event-id': '99' },
  });

  assert.equal(replay.status, 200);
  assert.deepEqual(
    Object.keys(replay.body).sort(),
    ['after', 'events', 'lastSequence', 'nextAfter', 'productionId'],
  );
  assert.equal(replay.body.productionId, id);
  assert.equal(replay.body.after, 0);
  assert.equal(replay.body.lastSequence, 2);
  assert.equal(replay.body.nextAfter, 2);
  assert.deepEqual(replay.body.events.map((event) => event.type), [
    'production.created',
    'plan.proposed',
  ]);

  const caughtUp = await call(routes, {
    method: 'GET',
    url: `/api/productions/${id}/events?after=2`,
  });
  assert.equal(caughtUp.status, 200);
  assert.equal(caughtUp.body.after, 2);
  assert.deepEqual(caughtUp.body.events, []);
  assert.equal(caughtUp.body.nextAfter, 2);
});

test('after beyond lastSequence resets to a snapshot', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);

  const reset = await call(routes, {
    method: 'GET',
    url: `/api/productions/${created.productionId}/events?after=99`,
  });

  assert.equal(reset.status, 200);
  assert.deepEqual(
    Object.keys(reset.body).sort(),
    ['after', 'lastSequence', 'productionId', 'reset', 'snapshot'],
  );
  assert.equal(reset.body.reset, true);
  assert.equal(reset.body.after, 99);
  assert.equal(reset.body.snapshot.production.id, created.productionId);
  assert.equal(reset.body.snapshot.revision, 1);
  assert.equal(reset.body.snapshot.lastSequence, 1);
  assert.equal('snapshotReset' in reset.body, false);
  assert.equal('type' in reset.body, false);
});

test('a trimmed or non-contiguous journal also resets to a snapshot', async (t) => {
  const { routes, runtimeDir } = setup(t);
  const created = await createProduction(routes, {
    commandId: 'cmd_trim',
    idempotencyKey: 'key_trim',
  });
  const id = created.productionId;
  await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: commandEnvelope('plan.propose', id, {
      commandId: 'cmd_trim_propose',
      idempotencyKey: 'key_trim_propose',
    }),
  });
  removeJournalLine(runtimeDir, id, 0);

  const trimmed = await call(routes, {
    method: 'GET',
    url: `/api/productions/${id}/events?after=0`,
  });
  assert.equal(trimmed.status, 200);
  assert.equal(trimmed.body.reset, true);
  assert.equal(trimmed.body.snapshot.lastSequence, 2);

  const second = await createProduction(routes, {
    commandId: 'cmd_gap',
    idempotencyKey: 'key_gap',
  });
  const secondId = second.productionId;
  for (const suffix of ['one', 'two']) {
    const response = await call(routes, {
      method: 'POST',
      url: `/api/productions/${secondId}/commands`,
      body: commandEnvelope('plan.propose', secondId, {
        commandId: `cmd_gap_${suffix}`,
        idempotencyKey: `key_gap_${suffix}`,
        expected: { productionRevision: suffix === 'one' ? 1 : 2 },
      }),
    });
    assert.equal(response.status, 200, response.raw);
  }
  removeJournalLine(runtimeDir, secondId, 1);

  const nonContiguous = await call(routes, {
    method: 'GET',
    url: `/api/productions/${secondId}/events?after=0`,
  });
  assert.equal(nonContiguous.status, 200);
  assert.equal(nonContiguous.body.reset, true);
  assert.equal(nonContiguous.body.snapshot.lastSequence, 3);
});

test('the URL id is authoritative and a body mismatch is a 400', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const mismatch = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: commandEnvelope('production.pause', 'prod_somewhere_else'),
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, 'PRODUCTION_ID_MISMATCH');
  assert.equal(store.read(id).revision, 1);

  const omitted = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: commandEnvelope('production.pause', undefined),
  });
  assert.equal(omitted.status, 200, omitted.raw);
  assert.equal(omitted.body.productionId, id);
  assert.equal(omitted.body.production.intent, 'paused');
  assert.equal(omitted.body.command.productionId, id);
});

test('create is refused on a command path and mutations are refused at the collection', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);

  const wrongCreate = await call(routes, {
    method: 'POST',
    url: `/api/productions/${created.productionId}/commands`,
    body: createEnvelope({ commandId: 'cmd_create_again' }),
  });
  assert.equal(wrongCreate.status, 400);
  assert.equal(wrongCreate.body.code, 'INVALID_COMMAND');

  const wrongMutation = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: commandEnvelope('production.pause', created.productionId),
  });
  assert.equal(wrongMutation.status, 400);
  assert.equal(wrongMutation.body.code, 'INVALID_COMMAND');
});

test('a request header cannot make the server context approve as a user', async (t) => {
  const { routes } = setup(t, () => ({ actor: 'agent', userEventId: 'ue_agent' }));
  const created = await createProduction(routes);
  const id = created.productionId;

  const approval = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    headers: { 'x-comfyrizz-actor': 'user', 'x-comfyrizz-user-event-id': 'ue_forged' },
    body: commandEnvelope('plan.approve', id, {
      payload: { planId: 'plan_1' },
    }),
  });

  assert.equal(approval.status, 403);
  assert.equal(approval.body.code, 'AGENT_CANNOT_APPROVE');
  assert.equal(approval.body.kind, 'plan.approve');
  assert.equal('stack' in approval.body, false);
});

test('createProductionRoutes requires contextFor and never defaults the actor', async (t) => {
  const { store, handler } = setup(t);
  assert.throws(
    () => createProductionRoutes({ store, handler }),
    (error) => error instanceof TypeError && /contextFor/.test(error.message),
  );

  const routes = createProductionRoutes({ store, handler, contextFor: () => ({}) });
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: createEnvelope({ commandId: 'cmd_missing_actor' }),
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'MISSING_ACTOR');
  assert.equal('stack' in response.body, false);
});

test('a reused idempotency key with a different payload is a 409', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const first = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: commandEnvelope('plan.propose', id, {
      commandId: 'cmd_same',
      idempotencyKey: 'key_same',
      payload: { note: 'first' },
    }),
  });
  assert.equal(first.status, 200, first.raw);

  const conflict = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: commandEnvelope('plan.propose', id, {
      commandId: 'cmd_same',
      idempotencyKey: 'key_same',
      payload: { note: 'second' },
    }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
});

test('a stale expected revision is a 409 carrying currentRevision', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const conflict = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: commandEnvelope('stage.advance', id, {
      expected: { productionRevision: 99 },
    }),
  });

  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'REVISION_CONFLICT');
  assert.equal(conflict.body.currentRevision, 1);
  assert.equal(conflict.body.baseRevision, 99);
});

test('malformed and oversized bodies fail without a stack trace', async (t) => {
  const { routes } = setup(t);

  const invalid = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: '{',
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_JSON');
  assert.equal('stack' in invalid.body, false);

  const oversized = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
    body: '{}',
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'BODY_TOO_LARGE');
  assert.equal('stack' in oversized.body, false);
});

test('non-matching paths return false and matched wrong methods return 405', async (t) => {
  const { routes } = setup(t);

  const unrelated = await call(routes, { method: 'GET', url: '/api/other' });
  assert.equal(unrelated.handled, false);

  const wrongMethod = await call(routes, { method: 'GET', url: '/api/productions' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.code, 'METHOD_NOT_ALLOWED');

  assert.equal(PRODUCTION_ROUTE_PATTERN.test('/api/productions'), true);
  assert.equal(PRODUCTION_ROUTE_PATTERN.test('/api/productions/prod_1'), true);
  assert.equal(PRODUCTION_ROUTE_PATTERN.test('/api/productions/prod_1/events'), true);
  assert.equal(PRODUCTION_ROUTE_PATTERN.test('/api/productions/prod_1/commands'), true);
  assert.equal(PRODUCTION_ROUTE_PATTERN.test('/api/productions/prod_1/other'), false);
});
