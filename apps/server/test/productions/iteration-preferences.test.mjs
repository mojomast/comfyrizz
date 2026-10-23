// IL09: iteration levels as scoped preferences.
//
// A level is saved as the `iteration.policy` preference at project or user
// scope. The preference store owns durability, identity and revisions; this
// module only adds a value validator keyed by the preference key, so an
// invalid policy is refused before anything is written.
//
// Revocation keeps the audit record but removes it from exposure, which makes
// the next scope (project -> user) the effective policy again. Choosing a
// level is never a spend approval.
//
// These tests use only the local filesystem. There are no network or paid
// calls, and no Google Colab dependency.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ITERATION_PRESETS,
  validateIterationPolicy,
} from '../../src/productions/iteration.mjs';
import {
  createPreferencesStore,
} from '../../src/productions/preferences.mjs';

const AT = '2026-10-23T10:40:00.000Z';
const POLICY_KEY = 'iteration.policy';

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-iteration-preferences-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeStore(runtimeDir) {
  return createPreferencesStore({ runtimeDir, clock: () => new Date(AT) });
}

function policy(level, overrides = {}) {
  const preset = ITERATION_PRESETS[level];
  return {
    level,
    stages: structuredClone(preset.stages),
    reviewDepth: preset.reviewDepth,
    shotOverrides: {},
    ...overrides,
  };
}

function setInput(overrides = {}) {
  const input = {
    scope: 'user',
    key: POLICY_KEY,
    value: policy('balanced'),
    actor: 'user',
    userEventId: 'ue_1',
    commandId: 'cmd_set_policy',
    ...overrides,
  };
  if (Object.hasOwn(overrides, 'commandId')) {
    input.idempotencyKey = `key_${overrides.commandId}`;
  }
  return input;
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    assert.equal(error?.status, code === 'AGENT_CANNOT_SET_PREFERENCE' ? 403 : 400);
    return true;
  });
}

test('saves a validated iteration policy at project and user scope', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(runtimeDir);
  const projectPolicy = policy('director');
  const userPolicy = policy('balanced');

  const project = store.set(setInput({
    scope: 'project',
    scopeId: 'proj_1',
    value: projectPolicy,
    commandId: 'cmd_project_policy',
  }));
  const user = store.set(setInput({
    value: userPolicy,
    commandId: 'cmd_user_policy',
  }));

  const expected = validateIterationPolicy(projectPolicy);
  assert.deepEqual(project.record.value, expected);
  assert.equal(project.record.value.level, 'director');
  assert.equal(user.record.value.level, 'balanced');

  const view = store.expose({ projectId: 'proj_1' });
  assert.deepEqual(view.data[POLICY_KEY], expected);
  assert.deepEqual(view.overrides, [{
    key: POLICY_KEY,
    winner: project.record.id,
    overridden: [user.record.id],
  }]);

  const reopened = makeStore(runtimeDir);
  assert.deepEqual(reopened.read(project.record.id).value, expected);
  assert.deepEqual(reopened.expose({ projectId: 'proj_1' }).data[POLICY_KEY], expected);
});

test('refuses an invalid iteration policy on set and correct without writing', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(runtimeDir);

  const tooManyTakes = policy('balanced');
  tooManyTakes.stages.video.takes = 99;
  assertCode(() => store.set(setInput({
    value: tooManyTakes,
    commandId: 'cmd_exceeded_policy',
  })), 'ITERATION_EXCEEDED');

  assertCode(() => store.set(setInput({
    value: { level: 'balanced', stages: policy('balanced').stages },
    commandId: 'cmd_invalid_policy',
  })), 'ITERATION_POLICY_INVALID');

  assertCode(() => store.set(setInput({
    value: policy('balanced', { level: 'friendly' }),
    commandId: 'cmd_alias_level',
  })), 'ITERATION_LEVEL_INVALID');

  assert.equal(store.revision(), 0);
  assert.deepEqual(store.list({ status: 'all' }), []);

  const created = store.set(setInput({
    value: policy('balanced'),
    commandId: 'cmd_valid_policy',
  }));
  const before = store.read(created.record.id);

  assertCode(() => store.correct({
    id: created.record.id,
    value: { level: 'director' },
    actor: 'user',
    userEventId: 'ue_2',
    commandId: 'cmd_bad_correct',
  }), 'ITERATION_POLICY_INVALID');

  assert.deepEqual(store.read(created.record.id), before);
  assert.equal(store.revision(), 1);

  // A refused command leaves no idempotency record, so the same command id may
  // be retried with a valid policy.
  const corrected = store.correct({
    id: created.record.id,
    value: policy('draft'),
    actor: 'user',
    userEventId: 'ue_2',
    commandId: 'cmd_bad_correct',
  });
  assert.equal(corrected.duplicate, false);
  assert.equal(corrected.record.value.level, 'draft');
  assert.equal(store.revision(), 2);
});

test('an agent may not save, correct or revoke an iteration policy', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(runtimeDir);

  const created = store.set(setInput({
    commandId: 'cmd_agent_policy_base',
  }));

  assertCode(() => store.set(setInput({
    scope: 'project',
    scopeId: 'proj_1',
    actor: 'agent',
    value: policy('director'),
    commandId: 'cmd_agent_policy_set',
  })), 'AGENT_CANNOT_SET_PREFERENCE');

  assertCode(() => store.correct({
    id: created.record.id,
    value: policy('director'),
    actor: 'agent',
    userEventId: 'ue_2',
    commandId: 'cmd_agent_policy_correct',
  }), 'AGENT_CANNOT_SET_PREFERENCE');

  assertCode(() => store.revoke({
    id: created.record.id,
    actor: 'agent',
    userEventId: 'ue_3',
    commandId: 'cmd_agent_policy_revoke',
  }), 'AGENT_CANNOT_SET_PREFERENCE');

  assert.equal(store.revision(), 1);
  assert.deepEqual(store.read(created.record.id).value, validateIterationPolicy(policy('balanced')));
});

test('correct updates the policy and revoke falls back from project to user', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(runtimeDir);

  store.set(setInput({
    value: policy('balanced'),
    commandId: 'cmd_user_default',
  }));
  const project = store.set(setInput({
    scope: 'project',
    scopeId: 'proj_1',
    value: policy('director'),
    commandId: 'cmd_project_default',
  }));

  assert.deepEqual(
    store.expose({ projectId: 'proj_1' }).data[POLICY_KEY],
    validateIterationPolicy(policy('director')),
  );

  const corrected = store.correct({
    id: project.record.id,
    value: policy('draft'),
    actor: 'user',
    userEventId: 'ue_2',
    commandId: 'cmd_correct_project',
  });
  assert.equal(corrected.record.id, project.record.id);
  assert.equal(corrected.record.value.level, 'draft');
  assert.deepEqual(
    store.expose({ projectId: 'proj_1' }).data[POLICY_KEY],
    validateIterationPolicy(policy('draft')),
  );

  const revoked = store.revoke({
    id: project.record.id,
    actor: 'user',
    userEventId: 'ue_3',
    commandId: 'cmd_revoke_project',
  });
  assert.equal(revoked.record.id, project.record.id);
  assert.equal(revoked.record.status, 'revoked');
  assert.equal(revoked.record.history.at(-1).action, 'revoke');

  const after = store.expose({ projectId: 'proj_1' });
  assert.deepEqual(after.data[POLICY_KEY], validateIterationPolicy(policy('balanced')));
  assert.deepEqual(after.overrides, []);
  assert.equal(store.list({ scope: 'project', scopeId: 'proj_1', key: POLICY_KEY }).length, 0);
  assert.equal(store.list({ scope: 'project', scopeId: 'proj_1', key: POLICY_KEY, status: 'revoked' }).length, 1);
  assert.equal(store.list({ scope: 'user', key: POLICY_KEY }).length, 1);
});

test('the policy validator is keyed to iteration.policy only', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(runtimeDir);

  const record = store.set(setInput({
    key: 'announcer',
    value: { pace: 'measured', policy: { level: 'balanced' } },
    commandId: 'cmd_other_key',
  }));
  assert.deepEqual(store.read(record.record.id).value, {
    pace: 'measured',
    policy: { level: 'balanced' },
  });
  assert.deepEqual(store.expose({}).data.announcer, {
    pace: 'measured',
    policy: { level: 'balanced' },
  });
});
