// IP18: the production command handler.
//
// Spec 7.1: every mutation is a command with a server-assigned actor and
// user-event attribution, a compare-and-swap revision, and an idempotency key
// that returns the recorded result for the same canonical payload. A replay
// with the same command id (or key) but a different payload is a conflict, and
// an agent may never approve a human decision.
//
// These tests only exercise the in-process command path and the IP17 store.
// There are no backend or network calls.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PRODUCTION_SCHEMA } from '../../src/productions/contract.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import {
  APPROVAL_COMMANDS,
  CommandError,
  canonicalJson,
  createCommandHandler,
  deterministicProductionId,
  requestHashFor,
} from '../../src/productions/commands.mjs';

const AT = '2026-10-22T12:00:00.000Z';

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-commands-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeHandler(t, runtimeDir) {
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  t.after(() => store.close?.());
  return { store, handler };
}

function context(overrides = {}) {
  return { actor: 'user', userEventId: 'ue_1', ...overrides };
}

function createEnvelope(overrides = {}) {
  return {
    commandId: 'cmd_create',
    idempotencyKey: 'key_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: { conversationId: 'conv_1', briefVersionId: 'brief_1' },
    ...overrides,
  };
}

function commandEnvelope(kind, productionId, overrides = {}) {
  return {
    commandId: `cmd_${kind.replaceAll('.', '_')}`,
    idempotencyKey: `key_${kind.replaceAll('.', '_')}`,
    kind,
    productionId,
    expected: { productionRevision: 1 },
    payload: { note: 'test' },
    ...overrides,
  };
}

function createProduction(handler, overrides = {}) {
  const result = handler.execute(createEnvelope(overrides), context());
  return result;
}

function assertCommandError(fn, code, status) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CommandError, `expected CommandError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('production.create is server-attributed and assigns a deterministic identity', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);

  const result = createProduction(handler);

  assert.equal(result.duplicate, false);
  assert.equal(result.committed, true);
  assert.equal(result.productionId, deterministicProductionId('cmd_create'));
  assert.equal(result.production.id, result.productionId);
  assert.equal(result.production.schema, PRODUCTION_SCHEMA);
  assert.equal(result.production.revision, 1);
  assert.equal(result.production.conversationId, 'conv_1');
  assert.equal(result.production.briefVersionId, 'brief_1');
  assert.equal(result.command.actor, 'user');
  assert.equal(result.command.userEventId, 'ue_1');
  assert.equal(result.command.productionId, result.productionId);

  const events = store.readEvents(result.productionId);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'production.created');
  assert.equal(events[0].commandId, 'cmd_create');
  assert.equal(events[0].userEventId, 'ue_1');
  assert.equal(store.read(result.productionId).lastSequence, 1);
});

test('the client cannot smuggle actor or userEventId through the envelope', (t) => {
  const runtimeDir = tempRuntime(t);
  const { handler } = makeHandler(t, runtimeDir);

  assertCommandError(
    () => handler.execute(createEnvelope({ actor: 'user' }), context()),
    'INVALID_COMMAND',
    400,
  );
  assertCommandError(
    () => handler.execute(createEnvelope({ userEventId: 'ue_forged' }), context()),
    'INVALID_COMMAND',
    400,
  );
});

test('an identical replay returns the recorded result and commits nothing', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);

  const first = createProduction(handler);
  const beforeEvents = store.readEvents(first.productionId);

  const replay = handler.execute(createEnvelope(), context({ userEventId: 'ue_replay' }));

  assert.equal(replay.duplicate, true);
  assert.equal(replay.committed, true);
  assert.equal(replay.productionId, first.productionId);
  assert.equal(replay.revision, first.revision);
  assert.deepEqual(replay.events.map((event) => event.id), beforeEvents.map((event) => event.id));
  assert.equal(store.read(first.productionId).revision, 1);
  assert.equal(store.readEvents(first.productionId).length, 1);
});

test('replay identity and conflict survive a restart with a fresh handler and no cache', (t) => {
  const runtimeDir = tempRuntime(t);
  const first = makeHandler(t, runtimeDir);
  const created = createProduction(first.handler);
  const beforeEvents = first.store.readEvents(created.productionId);

  const second = makeHandler(t, runtimeDir);
  const replay = second.handler.execute(createEnvelope(), context({ userEventId: 'ue_restart' }));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.productionId, created.productionId);
  assert.deepEqual(replay.events.map((event) => event.id), beforeEvents.map((event) => event.id));
  assert.equal(second.store.readEvents(created.productionId).length, 1);

  assertCommandError(
    () => second.handler.execute(
      createEnvelope({ payload: { conversationId: 'conv_other' } }),
      context({ userEventId: 'ue_restart_2' }),
    ),
    'IDEMPOTENCY_CONFLICT',
    409,
  );
  assert.equal(second.store.readEvents(created.productionId).length, 1);
});

test('a replay with the same key but a different canonical payload is a conflict', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  const approve = commandEnvelope('plan.approve', created.productionId, {
    commandId: 'cmd_approve',
    idempotencyKey: 'key_approve',
    payload: { planId: 'plan_1', proposalRevision: 1 },
  });
  handler.execute(approve, context({ userEventId: 'ue_approve' }));
  const revision = store.read(created.productionId).revision;
  const eventCount = store.readEvents(created.productionId).length;

  assertCommandError(
    () => handler.execute({ ...approve, payload: { planId: 'plan_2', proposalRevision: 1 } }, context({ userEventId: 'ue_other' })),
    'IDEMPOTENCY_CONFLICT',
    409,
  );
  assert.equal(store.read(created.productionId).revision, revision);
  assert.equal(store.readEvents(created.productionId).length, eventCount);
});

test('the same idempotency key with a different commandId is still the recorded command', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  const first = commandEnvelope('plan.approve', created.productionId, {
    commandId: 'cmd_first',
    idempotencyKey: 'key_shared',
    expected: { productionRevision: 1 },
  });
  handler.execute(first, context({ userEventId: 'ue_first' }));

  const replay = handler.execute(
    { ...first, commandId: 'cmd_second' },
    context({ userEventId: 'ue_second' }),
  );
  assert.equal(replay.duplicate, true);
  assert.equal(store.read(created.productionId).revision, 2);
  assert.equal(store.readEvents(created.productionId).length, 2);
});

test('canonical payload hashing is key-order independent', (t) => {
  const runtimeDir = tempRuntime(t);
  const { handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  const base = commandEnvelope('plan.approve', created.productionId, {
    commandId: 'cmd_order',
    idempotencyKey: 'key_order',
    payload: { a: 1, b: { c: 2, d: 3 } },
  });
  handler.execute(base, context({ userEventId: 'ue_order' }));
  const replay = handler.execute(
    { ...base, payload: { b: { d: 3, c: 2 }, a: 1 } },
    context({ userEventId: 'ue_order_2' }),
  );
  assert.equal(replay.duplicate, true);
});

test('requestHashFor hashes exactly kind, productionId, expected and payload', () => {
  const envelope = commandEnvelope('plan.approve', 'prod_x', {
    payload: { b: 2, a: 1 },
    expected: { productionRevision: 4, packageRevision: 9 },
  });
  const expected = createHash('sha256').update(canonicalJson({
    kind: 'plan.approve',
    productionId: 'prod_x',
    expected: { productionRevision: 4, packageRevision: 9 },
    payload: { a: 1, b: 2 },
  })).digest('hex');
  assert.equal(requestHashFor(envelope, 'prod_x'), expected);
  assert.equal(canonicalJson({ b: 2, a: [3, { d: 4, c: 5 }] }), '{"a":[3,{"c":5,"d":4}],"b":2}');
});

test('a missing server context is a server bug, never a default user', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  const approve = commandEnvelope('plan.approve', created.productionId, {
    commandId: 'cmd_no_context',
    idempotencyKey: 'key_no_context',
  });

  assertCommandError(() => handler.execute(approve), 'MISSING_ACTOR', 500);
  assertCommandError(() => handler.execute(approve, {}), 'MISSING_ACTOR', 500);
  assertCommandError(() => handler.execute(approve, { actor: '' }), 'MISSING_ACTOR', 500);
  assertCommandError(
    () => handler.execute(approve, { actor: 'user' }),
    'MISSING_USER_EVENT',
    500,
  );

  assert.equal(store.read(created.productionId).revision, 1);
  assert.equal(store.readEvents(created.productionId).length, 1);
});

test('an agent cannot approve, reject, select takes or override a gate', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  for (const kind of APPROVAL_COMMANDS) {
    const envelope = commandEnvelope(kind, created.productionId, {
      commandId: `cmd_agent_${kind.replaceAll('.', '_')}`,
      idempotencyKey: `key_agent_${kind.replaceAll('.', '_')}`,
    });
    assertCommandError(
      () => handler.execute(envelope, { actor: 'agent', userEventId: `ue_agent_${kind}` }),
      'AGENT_CANNOT_APPROVE',
      403,
    );
  }

  assert.equal(store.read(created.productionId).revision, 1);
  assert.equal(store.readEvents(created.productionId).length, 1);

  const approved = handler.execute(
    commandEnvelope('plan.approve', created.productionId, { expected: { productionRevision: 1 } }),
    context({ userEventId: 'ue_human_approval' }),
  );
  assert.equal(approved.revision, 2);
  const events = store.readEvents(created.productionId);
  assert.equal(events.at(-1).type, 'plan.approved');
  assert.equal(events.at(-1).userEventId, 'ue_human_approval');
});

test('an identical agent replay is returned before the approval gate, without leaking a conflict', (t) => {
  const runtimeDir = tempRuntime(t);
  const first = makeHandler(t, runtimeDir);
  const created = createProduction(first.handler);
  const approve = commandEnvelope('plan.approve', created.productionId, {
    commandId: 'cmd_replay_gate',
    idempotencyKey: 'key_replay_gate',
  });
  first.handler.execute(approve, context({ userEventId: 'ue_approved' }));

  const second = makeHandler(t, runtimeDir);
  const replay = second.handler.execute(approve);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 2);

  assertCommandError(
    () => second.handler.execute({ ...approve, payload: { note: 'different' } }),
    'IDEMPOTENCY_CONFLICT',
    409,
  );
});

test('a stale expected.productionRevision is a 409 and commits nothing', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  const stale = commandEnvelope('plan.approve', created.productionId, {
    commandId: 'cmd_stale',
    idempotencyKey: 'key_stale',
    expected: { productionRevision: 0 },
  });
  assert.throws(
    () => handler.execute(stale, context({ userEventId: 'ue_stale' })),
    (error) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.code, 'REVISION_CONFLICT');
      assert.equal(error.status, 409);
      assert.equal(error.currentRevision, 1);
      return true;
    },
  );
  assert.equal(store.read(created.productionId).revision, 1);
  assert.equal(store.readEvents(created.productionId).length, 1);

  const fresh = handler.execute(
    { ...stale, expected: { productionRevision: 1 }, commandId: 'cmd_fresh', idempotencyKey: 'key_fresh' },
    context({ userEventId: 'ue_fresh' }),
  );
  assert.equal(fresh.revision, 2);
});

test('a missing production is a 404 with no local path in the error', (t) => {
  const runtimeDir = tempRuntime(t);
  const { handler } = makeHandler(t, runtimeDir);
  const missing = commandEnvelope('production.pause', 'prod_missing', {
    commandId: 'cmd_missing',
    idempotencyKey: 'key_missing',
    expected: { productionRevision: 0 },
  });

  assert.throws(
    () => handler.execute(missing, context()),
    (error) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.status, 404);
      const serialized = `${error.message} ${JSON.stringify(error.details ?? {})}`;
      assert.equal(serialized.includes(runtimeDir), false);
      assert.equal(serialized.includes('/tmp'), false);
      return true;
    },
  );
});

test('a system command needs no userEventId, but still gets a command id', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  const paused = handler.execute(
    commandEnvelope('production.pause', created.productionId, {
      commandId: 'cmd_system_pause',
      idempotencyKey: 'key_system_pause',
    }),
    { actor: 'system' },
  );
  assert.equal(paused.production.intent, 'paused');
  const events = store.readEvents(created.productionId);
  assert.equal(events.at(-1).type, 'production.intent_changed');
  assert.equal(events.at(-1).commandId, 'cmd_system_pause');
  assert.equal(Object.prototype.hasOwnProperty.call(events.at(-1), 'userEventId'), false);
});

test('commands mutate the production through events and never call a backend', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the command handler must not make network calls');
  };
  try {
    const approved = handler.execute(
      commandEnvelope('plan.approve', created.productionId, {
        commandId: 'cmd_no_fetch',
        idempotencyKey: 'key_no_fetch',
        payload: { planId: 'plan_9', proposalRevision: 2 },
      }),
      context({ userEventId: 'ue_no_fetch' }),
    );
    assert.equal(approved.production.revision, 2);
    assert.equal(store.read(created.productionId).revision, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
