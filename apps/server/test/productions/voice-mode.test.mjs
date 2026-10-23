// VX14: production-level voice-mode override (production.h3VoiceMode).
//
// Modelled on iteration.set: one command, one event, closed payload, user only.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COMMANDS,
  EVENTS,
  validateCommandEnvelope,
  validateEvent,
  validateRecordedCommand,
} from '../../src/productions/contract.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import {
  CommandError,
  createCommandHandler,
} from '../../src/productions/commands.mjs';

const AT = '2026-10-23T10:35:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_voice_mode' });

function clone(value) {
  return structuredClone(value);
}

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-voice-mode-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeHandler(t, runtimeDir) {
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  t.after(() => store.close?.());
  return { store, handler };
}

function validCommand(overrides = {}) {
  return {
    commandId: 'cmd_voice_mode_1',
    productionId: 'prod_1',
    expected: { productionRevision: 4 },
    kind: 'voice_mode.set',
    payload: { h3VoiceMode: 'prompt' },
    ...overrides,
  };
}

function validEvent(overrides = {}) {
  return {
    id: 'evt_voice_mode_1',
    productionId: 'prod_1',
    sequence: 14,
    type: 'voice_mode.set',
    at: AT,
    data: { h3VoiceMode: 'prompt' },
    ...overrides,
  };
}

function assertValid(result, label) {
  assert.deepEqual(result, { ok: true, errors: [] }, `${label} should be valid`);
}

function assertError(result, label, code, pathPart) {
  assert.equal(result.ok, false, `${label} should be invalid`);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, `${label} should report errors`);
  for (const error of result.errors) {
    assert.equal(typeof error.path, 'string');
    assert.equal(typeof error.code, 'string');
    assert.ok(error.path.startsWith('/'), `error path should be a JSON pointer, got ${error.path}`);
  }
  if (code) {
    assert.ok(
      result.errors.some((error) => error.code === code),
      `${label} should include code ${code}; got ${JSON.stringify(result.errors)}`,
    );
  }
  if (pathPart) {
    assert.ok(
      result.errors.some((error) => error.path.includes(pathPart)),
      `${label} should include a path containing ${pathPart}; got ${JSON.stringify(result.errors)}`,
    );
  }
}

function createProduction(handler, overrides = {}) {
  return handler.execute({
    commandId: 'cmd_create',
    idempotencyKey: 'key_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: {
      conversationId: 'conv_voice_mode',
      shotIds: ['shot_1'],
      ...overrides,
    },
  }, USER);
}

function setEnvelope(productionId, revision, overrides = {}) {
  return {
    commandId: 'cmd_voice_mode',
    idempotencyKey: 'key_voice_mode',
    kind: 'voice_mode.set',
    productionId,
    expected: { productionRevision: revision },
    payload: { h3VoiceMode: 'prompt' },
    ...overrides,
  };
}

function assertCommandError(fn, code, status) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CommandError, `expected CommandError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

// --- Vocabulary -----------------------------------------------------------

test('voice_mode.set is one command and one event, and the lists stay frozen', () => {
  assert.ok(COMMANDS.includes('voice_mode.set'), 'COMMANDS is missing voice_mode.set');
  assert.ok(EVENTS.includes('voice_mode.set'), 'EVENTS is missing voice_mode.set');
  assert.equal(COMMANDS.filter((kind) => kind === 'voice_mode.set').length, 1);
  assert.equal(EVENTS.filter((type) => type === 'voice_mode.set').length, 1);
  assert.equal(Object.isFrozen(COMMANDS), true);
  assert.equal(Object.isFrozen(EVENTS), true);
});

// --- Contract: command envelope ------------------------------------------

test('a voice_mode.set envelope validates for clip, prompt and null', () => {
  for (const mode of ['clip', 'prompt', null]) {
    assertValid(
      validateCommandEnvelope(validCommand({ payload: { h3VoiceMode: mode } })),
      `voice_mode.set ${mode}`,
    );
  }
});

test('a voice_mode.set envelope rejects an invalid h3VoiceMode', () => {
  assertError(
    validateCommandEnvelope(validCommand({ payload: { h3VoiceMode: 'bogus' } })),
    'invalid mode',
    'INVALID_H3_VOICE_MODE',
    '/payload/h3VoiceMode',
  );
  assertError(
    validateCommandEnvelope(validCommand({ payload: { h3VoiceMode: 42 } })),
    'non-string mode',
    'INVALID_H3_VOICE_MODE',
    '/payload/h3VoiceMode',
  );
});

test('a voice_mode.set envelope rejects a missing h3VoiceMode', () => {
  assertError(
    validateCommandEnvelope(validCommand({ payload: {} })),
    'missing mode',
    'INVALID_H3_VOICE_MODE',
    '/payload/h3VoiceMode',
  );
});

test('a voice_mode.set envelope rejects extra keys', () => {
  assertError(
    validateCommandEnvelope(validCommand({ payload: { h3VoiceMode: 'prompt', extra: true } })),
    'extra key',
    'UNKNOWN_FIELD',
    '/payload/extra',
  );
});

test('a voice_mode.set envelope rejects a null payload field alias', () => {
  assertError(
    validateCommandEnvelope(validCommand({ payload: { h3Mode: 'prompt' } })),
    'wrong key',
    'UNKNOWN_FIELD',
    '/payload/h3Mode',
  );
});

test('a recorded voice_mode.set command keeps server attribution and validates', () => {
  assertValid(
    validateRecordedCommand({
      ...validCommand(),
      actor: 'user',
      userEventId: 'ue_1',
      at: AT,
    }),
    'recorded voice_mode.set',
  );
});

// --- Contract: event ------------------------------------------------------

test('a voice_mode.set event validates for clip, prompt and null', () => {
  for (const mode of ['clip', 'prompt', null]) {
    assertValid(
      validateEvent(validEvent({ data: { h3VoiceMode: mode } })),
      `voice_mode.set event ${mode}`,
    );
  }
});

test('a voice_mode.set event rejects invalid and extra fields', () => {
  assertError(
    validateEvent(validEvent({ data: { h3VoiceMode: 'nope' } })),
    'invalid event mode',
    'INVALID_H3_VOICE_MODE',
    '/data/h3VoiceMode',
  );
  assertError(
    validateEvent(validEvent({ data: { h3VoiceMode: 'prompt', approved: true } })),
    'event extra key',
    'UNKNOWN_FIELD',
    '/data/approved',
  );
  assertError(
    validateEvent(validEvent({ data: {} })),
    'event missing mode',
    'INVALID_H3_VOICE_MODE',
    '/data/h3VoiceMode',
  );
});

// --- Command handler ------------------------------------------------------

test('a user sets the production voice mode and the projection survives a restart', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  const result = handler.execute(setEnvelope(created.productionId, created.revision, {
    payload: { h3VoiceMode: 'prompt' },
  }), USER);

  assert.equal(result.duplicate, false);
  assert.equal(result.committed, true);
  assert.equal(result.revision, 2);
  assert.equal(result.production.h3VoiceMode, 'prompt');

  const events = store.readEvents(created.productionId);
  assert.equal(events.at(-1).type, 'voice_mode.set');
  assert.equal(events.at(-1).userEventId, 'ue_voice_mode');
  assert.equal(events.at(-1).data.h3VoiceMode, 'prompt');

  const reopened = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  t.after(() => reopened.close?.());
  assert.equal(reopened.read(created.productionId).h3VoiceMode, 'prompt');
});

test('h3VoiceMode is absent until first set', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  assert.equal(Object.prototype.hasOwnProperty.call(store.read(created.productionId), 'h3VoiceMode'), false);
});

test('null clears the override to null', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  handler.execute(setEnvelope(created.productionId, created.revision, {
    payload: { h3VoiceMode: 'prompt' },
  }), USER);
  const cleared = handler.execute(setEnvelope(created.productionId, store.read(created.productionId).revision, {
    commandId: 'cmd_voice_mode_clear',
    idempotencyKey: 'key_voice_mode_clear',
    payload: { h3VoiceMode: null },
  }), USER);
  assert.equal(cleared.production.h3VoiceMode, null);
  const reopened = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  t.after(() => reopened.close?.());
  assert.equal(reopened.read(created.productionId).h3VoiceMode, null);
});

test('only a user may set the voice mode', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  const envelope = setEnvelope(created.productionId, created.revision);

  for (const context of [
    { actor: 'agent', userEventId: 'ue_agent' },
    { actor: 'system' },
  ]) {
    assertCommandError(
      () => handler.execute(envelope, context),
      'VOICE_MODE_USER_ONLY',
      403,
    );
  }

  assert.equal(store.read(created.productionId).revision, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(store.read(created.productionId), 'h3VoiceMode'), false);
  assert.equal(store.readEvents(created.productionId).length, 1);
});

test('a replay is a duplicate and a changed replay is IDEMPOTENCY_CONFLICT', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  const envelope = setEnvelope(created.productionId, created.revision);
  const first = handler.execute(envelope, USER);

  const replay = handler.execute(envelope, { actor: 'user', userEventId: 'ue_replay' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, first.revision);
  assert.equal(replay.production.h3VoiceMode, first.production.h3VoiceMode);
  assert.equal(store.readEvents(created.productionId).filter((event) => event.type === 'voice_mode.set').length, 1);

  assertCommandError(
    () => handler.execute(
      { ...envelope, payload: { h3VoiceMode: 'clip' } },
      USER,
    ),
    'IDEMPOTENCY_CONFLICT',
    409,
  );
  assert.equal(store.read(created.productionId).revision, first.revision);
});

test('voice_mode.set starts and reserves nothing', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  const before = store.read(created.productionId);
  handler.execute(setEnvelope(created.productionId, created.revision, {
    payload: { h3VoiceMode: 'clip' },
  }), USER);
  const after = store.read(created.productionId);
  assert.deepEqual(after.actionIds, before.actionIds);
  assert.deepEqual(after.pendingDecisionIds, before.pendingDecisionIds);
  assert.equal(after.latestDeliveryId, before.latestDeliveryId);
});
