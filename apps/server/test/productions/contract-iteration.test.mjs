// IL02: iteration.set vocabulary in the shared production contract.
//
// The iteration policy has its own pure validator (IL01). This test pins the
// junction: `iteration.set` is one command and one event, its payload carries
// a policy that must pass that validator plus an optional shot scope, and the
// three iteration failure codes are exported for every later module to cite.
//
// Existing commands, events and fixtures are not restated here; contract.test
// keeps them unchanged.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  EVENTS,
  ITERATION_EXCEEDED,
  ITERATION_LEVEL_REQUIRED,
  ITERATION_SHOT_LOCKED,
  validateCommandEnvelope,
  validateEvent,
  validateRecordedCommand,
} from '../../src/productions/contract.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';

const AT = '2026-10-23T10:35:00.000Z';

function clone(value) {
  return structuredClone(value);
}

function validPolicy(overrides = {}) {
  return {
    level: 'balanced',
    stages: clone(ITERATION_PRESETS.balanced.stages),
    reviewDepth: 'standard',
    shotOverrides: {},
    ...overrides,
  };
}

function validCommand(overrides = {}) {
  return {
    commandId: 'cmd_iteration_1',
    productionId: 'prod_1',
    expected: { productionRevision: 4 },
    kind: 'iteration.set',
    payload: {
      policy: validPolicy(),
      scope: { shotIds: ['shot_1', 'shot_2'] },
    },
    ...overrides,
  };
}

function validEvent(overrides = {}) {
  return {
    id: 'evt_iteration_1',
    productionId: 'prod_1',
    sequence: 14,
    type: 'iteration.set',
    at: AT,
    data: {
      policy: validPolicy(),
      scope: { shotIds: ['shot_1'] },
    },
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
    assert.equal(typeof error.message, 'string');
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

// --- Vocabulary ------------------------------------------------------------

test('iteration.set is one command and one event, and the lists stay frozen', () => {
  assert.ok(COMMANDS.includes('iteration.set'), 'COMMANDS is missing iteration.set');
  assert.ok(EVENTS.includes('iteration.set'), 'EVENTS is missing iteration.set');
  assert.equal(COMMANDS.filter((kind) => kind === 'iteration.set').length, 1);
  assert.equal(EVENTS.filter((type) => type === 'iteration.set').length, 1);
  assert.equal(Object.isFrozen(COMMANDS), true);
  assert.equal(Object.isFrozen(EVENTS), true);
});

test('the iteration error codes are exported constants with their exact code', () => {
  assert.equal(ITERATION_LEVEL_REQUIRED, 'ITERATION_LEVEL_REQUIRED');
  assert.equal(ITERATION_EXCEEDED, 'ITERATION_EXCEEDED');
  assert.equal(ITERATION_SHOT_LOCKED, 'ITERATION_SHOT_LOCKED');
  assert.equal(
    new Set([ITERATION_LEVEL_REQUIRED, ITERATION_EXCEEDED, ITERATION_SHOT_LOCKED]).size,
    3,
    'the three iteration error codes are distinct',
  );
});

// --- Command envelope ------------------------------------------------------

test('an iteration.set envelope validates with and without a shot scope', () => {
  assertValid(validateCommandEnvelope(validCommand()), 'iteration.set with scope');
  assertValid(
    validateCommandEnvelope(validCommand({
      payload: { policy: validPolicy({ level: 'draft' }) },
    })),
    'iteration.set without scope',
  );
  assertValid(
    validateCommandEnvelope(validCommand({
      payload: { policy: validPolicy(), scope: { shotIds: [] } },
    })),
    'iteration.set with an empty scope',
  );
});

test('a recorded iteration.set command keeps server attribution and validates', () => {
  assertValid(
    validateRecordedCommand({
      ...validCommand(),
      actor: 'user',
      userEventId: 'ue_1',
      at: AT,
    }),
    'recorded iteration.set',
  );
});

test('an iteration.set envelope without a policy is rejected', () => {
  assertError(
    validateCommandEnvelope(validCommand({ payload: {} })),
    'iteration.set without a policy',
    'INVALID_OBJECT',
    '/payload/policy',
  );
  assertError(
    validateCommandEnvelope(validCommand({ payload: { policy: null } })),
    'iteration.set with a null policy',
    'INVALID_OBJECT',
    '/payload/policy',
  );
});

test('an iteration.set envelope rejects an invalid policy with the policy validator code', () => {
  const missingStage = validPolicy();
  delete missingStage.stages.voice;

  assertError(
    validateCommandEnvelope(validCommand({ payload: { policy: missingStage } })),
    'incomplete policy',
    'ITERATION_POLICY_INVALID',
    '/payload/policy',
  );
  assertError(
    validateCommandEnvelope(validCommand({
      payload: { policy: validPolicy({ level: 'cinematic' }) },
    })),
    'unknown level',
    'ITERATION_LEVEL_INVALID',
    '/payload/policy',
  );

  const overLimit = validPolicy();
  overLimit.stages.video = { takes: 5, rounds: 1, auditions: 0, pick: 'ask' };
  assertError(
    validateCommandEnvelope(validCommand({ payload: { policy: overLimit } })),
    'policy beyond the D4 take limit',
    ITERATION_EXCEEDED,
    '/payload/policy',
  );
});

test('an iteration.set scope names unique shot ids and nothing else', () => {
  assertError(
    validateCommandEnvelope(validCommand({ payload: { policy: validPolicy(), scope: { shotIds: 'shot_1' } } })),
    'non-array shot ids',
    'INVALID_ARRAY',
    '/payload/scope/shotIds',
  );
  assertError(
    validateCommandEnvelope(validCommand({
      payload: { policy: validPolicy(), scope: { shotIds: ['shot_1', 'shot_1'] } },
    })),
    'duplicate shot ids',
    'DUPLICATE_ID',
    '/payload/scope/shotIds',
  );
  assertError(
    validateCommandEnvelope(validCommand({
      payload: { policy: validPolicy(), scope: { shotIds: ['shot_1'], unexpected: true } },
    })),
    'unknown scope field',
    'UNKNOWN_FIELD',
    '/payload/scope/unexpected',
  );
});

// --- Event -----------------------------------------------------------------

test('an iteration.set event validates with and without a scope', () => {
  assertValid(validateEvent(validEvent()), 'iteration.set event with scope');
  assertValid(
    validateEvent(validEvent({ data: { policy: validPolicy({ level: 'director' }) } })),
    'iteration.set event without scope',
  );
});

test('an iteration.set event rejects a missing or invalid policy', () => {
  assertError(
    validateEvent(validEvent({ data: {} })),
    'event without a policy',
    'INVALID_OBJECT',
    '/data/policy',
  );

  const overLimit = validPolicy();
  overLimit.stages.script = { takes: 5, rounds: 1, auditions: 0, pick: 'auto' };
  assertError(
    validateEvent(validEvent({ data: { policy: overLimit } })),
    'event policy beyond the D4 take limit',
    ITERATION_EXCEEDED,
    '/data/policy',
  );
});

test('an iteration.set data object is closed', () => {
  assertError(
    validateEvent(validEvent({ data: { policy: validPolicy(), approved: true } })),
    'event data cannot smuggle a spend approval',
    'UNKNOWN_FIELD',
    '/data/approved',
  );
});
