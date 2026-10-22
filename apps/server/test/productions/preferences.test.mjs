// IP38: scoped production preferences.
//
// The preference store is deliberately small and closed-vocabulary:
//
//   * scopes are exactly user, project, character and language (BCP-47);
//   * a scope is always explicit, never inferred from an id field;
//   * every mutation cites a user event and an explicit actor;
//   * an agent may recommend, but only a user (or a migration) may save;
//   * the durable snapshot is one owner-only JSON file with CAS revision and
//     per-command idempotency records;
//   * expose() resolves character > language > project > user and reports
//     explicit overrides, returning data plus plain text and a fingerprint.
//
// These tests use only the local filesystem. There are no network or paid
// calls, and no Google Colab dependency.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PreferencesError,
  createPreferencesStore,
} from '../../src/productions/preferences.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const LATER = '2026-10-22T12:05:00.000Z';

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-preferences-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeStore(t, runtimeDir, options = {}) {
  const store = createPreferencesStore({
    runtimeDir,
    clock: () => new Date(AT),
    ...options,
  });
  return store;
}

function prefsOf(runtimeDir) {
  return join(runtimeDir, 'preferences', 'preferences.json');
}

function setInput(overrides = {}) {
  const input = {
    scope: 'user',
    key: 'announcer',
    value: 'avoid generic announcer',
    actor: 'user',
    userEventId: 'ue_1',
    commandId: 'cmd_set_1',
    idempotencyKey: 'key_set_1',
    ...overrides,
  };
  // A test that supplies a new command id gets its own key unless it names one
  // explicitly; reusing the default key would be a legitimate conflict.
  if (owns(overrides, 'commandId') && !owns(overrides, 'idempotencyKey')) {
    input.idempotencyKey = `key_${overrides.commandId}`;
  }
  return input;
}

function owns(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPrefError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof PreferencesError, `expected PreferencesError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('set requires an explicit scope and never defaults one to user', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const { scope, ...noScope } = setInput();
  assertPrefError(() => store.set(noScope), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: null })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'global' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'production', scopeId: 'prod_1' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'accent', scopeId: 'en-US' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'locale', scopeId: 'en-US' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'character:basil' })), 'INVALID_SCOPE');

  // Nothing was written by any of those refused commands.
  assert.equal(store.revision(), 0);
  assert.equal(fs.existsSync(prefsOf(runtimeDir)), false);
  assert.deepEqual(store.list(), []);
});

test('set requires actor, user event and a caller command id', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const { actor, ...noActor } = setInput();
  assertPrefError(() => store.set(noActor), 'MISSING_ACTOR');
  const { userEventId, ...noEvent } = setInput();
  assertPrefError(() => store.set(noEvent), 'MISSING_USER_EVENT');
  const { commandId, idempotencyKey, ...noCommand } = setInput();
  assertPrefError(() => store.set(noCommand), 'MISSING_COMMAND_ID');
  assertPrefError(() => store.set(setInput({ commandId: '', idempotencyKey: '' })), 'MISSING_COMMAND_ID');

  // An explicit actor is mandatory. There is no implicit "user" and the
  // agent can only propose, never persist.
  const { actor: ignored, ...noActorAgain } = setInput({ commandId: 'cmd_no_actor' });
  assertPrefError(() => store.set(noActorAgain), 'MISSING_ACTOR');
  assertPrefError(() => store.set(setInput({ actor: 'agent', commandId: 'cmd_agent' })), 'AGENT_CANNOT_SET_PREFERENCE');
  assertPrefError(() => store.set(setInput({ actor: 'robot', commandId: 'cmd_robot' })), 'INVALID_ACTOR');

  assert.equal(store.revision(), 0);
  assert.deepEqual(store.list(), []);
});

test('set accepts exactly one input shape and rejects every alias', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const aliases = [
    { scopeKind: 'user' },
    { scopeType: 'user' },
    { characterId: 'basil' },
    { projectId: 'proj_1' },
    { language: 'en-US' },
    { languageId: 'en-US' },
    { locale: 'en-US' },
    { accent: 'en-US' },
    { targetId: 'basil' },
    { id: 'basil' },
    { scope: { kind: 'character', id: 'basil' } },
  ];
  for (const alias of aliases) {
    assertPrefError(
      () => store.set(setInput({ ...alias, commandId: `cmd_alias_${Object.keys(alias)[0]}` })),
      Object.keys(alias)[0] === 'scope' ? 'INVALID_SCOPE' : 'INVALID_INPUT',
    );
  }
  assertPrefError(() => store.set(setInput({ unknown: true, commandId: 'cmd_unknown' })), 'INVALID_INPUT');
  assert.equal(store.revision(), 0);
});

test('scope ids are required where the scope needs one', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  assertPrefError(() => store.set(setInput({ scope: 'project' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'character' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'language' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'user', scopeId: 'someone' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'project', scopeId: '' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'character', scopeId: 'bad id' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'language', scopeId: 'not a locale' })), 'INVALID_SCOPE');
  assertPrefError(() => store.set(setInput({ scope: 'language', scopeId: 'en-US-u-ca-gregory' })), 'INVALID_SCOPE');

  assert.equal(store.revision(), 0);
});

test('persists one owner-only snapshot and reloads it', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const result = store.set(setInput());
  assert.equal(result.duplicate, false);
  assert.equal(result.record.scope, 'user');
  assert.equal(result.record.scopeId, null);
  assert.equal(result.record.key, 'announcer');
  assert.equal(result.record.value, 'avoid generic announcer');
  assert.equal(result.record.actor, 'user');
  assert.equal(result.record.userEventId, 'ue_1');
  assert.equal(result.record.status, 'active');
  assert.match(result.record.id, /^pref_[a-f0-9]+$/);
  assert.equal(result.record.history.length, 1);
  assert.equal(result.record.history[0].action, 'set');
  assert.equal(result.record.history[0].value, 'avoid generic announcer');
  assert.equal(store.revision(), 1);

  const file = prefsOf(runtimeDir);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(fs.readdirSync(join(runtimeDir, 'preferences')), ['preferences.json']);
  assert.equal(fs.statSync(join(runtimeDir, 'preferences')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const reopened = makeStore(t, runtimeDir, { clock: () => new Date(LATER) });
  assert.equal(reopened.revision(), 1);
  assert.deepEqual(reopened.read(result.record.id), result.record);
  assert.deepEqual(reopened.list(), [result.record]);

  // A replayed command after a restart is still the same durable command.
  const replay = reopened.set(setInput());
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.record, result.record);
  assert.equal(reopened.revision(), 1);
});

test('exposes user preferences for every character and keeps character preferences isolated', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  store.set(setInput());
  const basil = store.set(setInput({
    scope: 'character',
    scopeId: 'basil',
    key: 'voice',
    value: 'basil-warm',
    userEventId: 'ue_2',
    commandId: 'cmd_basil',
    idempotencyKey: 'key_basil',
  }));
  const pip = store.set(setInput({
    scope: 'character',
    scopeId: 'pip',
    key: 'voice',
    value: 'pip-bright',
    userEventId: 'ue_3',
    commandId: 'cmd_pip',
    idempotencyKey: 'key_pip',
  }));

  const basilView = store.expose({ characterId: 'basil' });
  assert.equal(basilView.data.announcer, 'avoid generic announcer');
  assert.equal(basilView.data.voice, 'basil-warm');

  const pipView = store.expose({ characterId: 'pip' });
  assert.equal(pipView.data.announcer, 'avoid generic announcer');
  assert.equal(pipView.data.voice, 'pip-bright');

  // Basil's saved voice is never applied to another character.
  const noCharacter = store.expose({});
  assert.equal(noCharacter.data.announcer, 'avoid generic announcer');
  assert.equal('voice' in noCharacter.data, false);

  // Even a different character with no voice gets no character preference.
  const other = store.expose({ characterId: 'other' });
  assert.equal('voice' in other.data, false);
  assert.notEqual(basil.record.id, pip.record.id);
});

test('exposes character > language > project > user and reports explicit overrides', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  store.set(setInput());
  const project = store.set(setInput({
    scope: 'project',
    scopeId: 'proj_1',
    key: 'voice',
    value: 'project-voice',
    commandId: 'cmd_project_voice',
  }));
  const language = store.set(setInput({
    scope: 'language',
    scopeId: 'en-us',
    key: 'voice',
    value: 'language-voice',
    commandId: 'cmd_language_voice',
  }));
  assert.equal(language.record.scopeId, 'en-US');

  // Values are resolved without the character override.
  const projectLanguage = store.expose({ projectId: 'proj_1', language: 'EN-us' });
  assert.equal(projectLanguage.data.voice, 'language-voice');
  assert.deepEqual(projectLanguage.overrides, [{
    key: 'voice',
    winner: language.record.id,
    overridden: [project.record.id],
  }]);

  const character = store.set(setInput({
    scope: 'character',
    scopeId: 'basil',
    key: 'voice',
    value: 'basil-voice',
    commandId: 'cmd_character_voice',
  }));
  assert.equal(character.record.scopeId, 'basil');

  const full = store.expose({ projectId: 'proj_1', characterId: 'basil', language: 'en-US' });
  assert.equal(full.data.voice, 'basil-voice');
  assert.deepEqual(full.overrides, [{
    key: 'voice',
    winner: character.record.id,
    overridden: [language.record.id, project.record.id],
  }]);

  // Requesting a different language does not expose the en-US record.
  const otherLanguage = store.expose({ projectId: 'proj_1', characterId: 'basil', language: 'en-GB' });
  assert.equal(otherLanguage.data.voice, 'basil-voice');
  assert.deepEqual(otherLanguage.overrides, [{
    key: 'voice',
    winner: character.record.id,
    overridden: [project.record.id],
  }]);

  // No project or language requested: only user and character scopes apply.
  const noTargets = store.expose({ characterId: 'basil' });
  assert.equal(noTargets.data.voice, 'basil-voice');
  assert.deepEqual(noTargets.overrides, []);

  // A duplicate language record is rejected rather than creating ambiguity.
  assertPrefError(() => store.set(setInput({
    scope: 'language',
    scopeId: 'EN-US',
    key: 'voice',
    value: 'another',
    commandId: 'cmd_language_duplicate',
  })), 'PREFERENCE_EXISTS');
});

test('a project preference overrides user and a language preference overrides project', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  store.set(setInput({ key: 'tone', value: 'user-tone', commandId: 'cmd_tone_user' }));
  const project = store.set(setInput({
    scope: 'project',
    scopeId: 'proj_1',
    key: 'tone',
    value: 'project-tone',
    commandId: 'cmd_tone_project',
  }));
  assert.equal(store.expose({ projectId: 'proj_1' }).data.tone, 'project-tone');
  assert.deepEqual(store.expose({ projectId: 'proj_1' }).overrides, [{
    key: 'tone',
    winner: project.record.id,
    overridden: [store.list({ scope: 'user' })[0].id],
  }]);

  const language = store.set(setInput({
    scope: 'language',
    scopeId: 'en-GB',
    key: 'tone',
    value: 'language-tone',
    commandId: 'cmd_tone_language',
  }));
  const view = store.expose({ projectId: 'proj_1', language: 'en-gb' });
  assert.equal(view.data.tone, 'language-tone');
  assert.equal(view.overrides[0].winner, language.record.id);
  assert.equal(view.overrides[0].overridden.length, 2);
});

test('correct keeps the stable id, appends history and is idempotent', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const created = store.set(setInput({
    scope: 'character',
    scopeId: 'basil',
    key: 'delivery',
    value: 'warm',
    commandId: 'cmd_delivery_set',
    idempotencyKey: 'key_delivery_set',
  })).record;

  const corrected = store.correct({
    id: created.id,
    value: 'dry',
    actor: 'user',
    userEventId: 'ue_2',
    commandId: 'cmd_delivery_correct',
    idempotencyKey: 'key_delivery_correct',
  });
  assert.equal(corrected.duplicate, false);
  assert.equal(corrected.record.id, created.id);
  assert.equal(corrected.record.value, 'dry');
  assert.equal(corrected.record.scope, 'character');
  assert.equal(corrected.record.scopeId, 'basil');
  assert.equal(corrected.record.history.length, 2);
  assert.equal(corrected.record.history[0].value, 'warm');
  assert.equal(corrected.record.history[1].value, 'dry');
  assert.equal(corrected.record.history[1].action, 'correct');
  assert.equal(corrected.record.actor, 'user');
  assert.equal(corrected.record.userEventId, 'ue_2');
  assert.equal(corrected.record.createdAt, created.createdAt);
  assert.equal(store.revision(), 2);

  const replay = store.correct({
    id: created.id,
    value: 'dry',
    actor: 'user',
    userEventId: 'ue_2',
    commandId: 'cmd_delivery_correct',
    idempotencyKey: 'key_delivery_correct',
  });
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.record, corrected.record);
  assert.equal(store.revision(), 2);
  assert.equal(store.read(created.id).history.length, 2);

  // Same caller key, different canonical payload is a conflict, not a replay.
  assertPrefError(() => store.correct({
    id: created.id,
    value: 'flat',
    actor: 'user',
    userEventId: 'ue_2',
    commandId: 'cmd_delivery_correct',
    idempotencyKey: 'key_delivery_correct',
  }), 'IDEMPOTENCY_CONFLICT');
  assert.equal(store.read(created.id).value, 'dry');
  assert.equal(store.revision(), 2);

  // Corrections also require explicit attribution and a caller key.
  const { actor, ...noActor } = { id: created.id, value: 'x', actor: 'user', userEventId: 'ue_3', commandId: 'cmd_c1' };
  assertPrefError(() => store.correct(noActor), 'MISSING_ACTOR');
  const { userEventId, ...noEvent } = { id: created.id, value: 'x', actor: 'user', userEventId: 'ue_3', commandId: 'cmd_c2' };
  assertPrefError(() => store.correct(noEvent), 'MISSING_USER_EVENT');
  const { commandId, ...noCommand } = { id: created.id, value: 'x', actor: 'user', userEventId: 'ue_3', commandId: 'cmd_c3' };
  assertPrefError(() => store.correct(noCommand), 'MISSING_COMMAND_ID');
  assertPrefError(() => store.correct({
    id: created.id, value: 'x', actor: 'agent', userEventId: 'ue_3', commandId: 'cmd_c4',
  }), 'AGENT_CANNOT_SET_PREFERENCE');
  assertPrefError(() => store.correct({
    id: created.id, value: 'x', actor: 'user', userEventId: 'ue_3', commandId: 'cmd_c5', scope: 'user',
  }), 'INVALID_INPUT');
  assertPrefError(() => store.correct({
    id: 'pref_missing', value: 'x', actor: 'user', userEventId: 'ue_3', commandId: 'cmd_c6',
  }), 'NOT_FOUND');
});

test('records are plain data with no hidden convenience views', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const created = store.set(setInput()).record;
  store.correct({
    id: created.id,
    value: 'avoid generic announcer, warm but not theatrical',
    actor: 'user',
    userEventId: 'ue_2',
    commandId: 'cmd_plain_correct',
  });
  const record = store.read(created.id);

  for (const hidden of [
    'duplicate', 'active', 'revoked', 'source', 'scopeRef', 'scopeKey',
    'projectId', 'characterId', 'language', 'previous',
  ]) {
    assert.equal(hidden in record, false, `unexpected convenience field ${hidden}`);
  }
  assert.deepEqual(Object.getOwnPropertyNames(record).sort(), Object.keys(record).sort());
  for (const entry of record.history) {
    assert.equal('previous' in entry, false);
    assert.deepEqual(Object.getOwnPropertyNames(entry).sort(), Object.keys(entry).sort());
  }
  // history() is the same plain history.
  assert.deepEqual(store.history(created.id), record.history);
});

test('revoke appends history, removes exposure and keeps the stable id', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const created = store.set(setInput()).record;
  const revoked = store.revoke({
    id: created.id,
    actor: 'user',
    userEventId: 'ue_2',
    reason: 'the user changed their mind',
    commandId: 'cmd_revoke_1',
    idempotencyKey: 'key_revoke_1',
  });
  assert.equal(revoked.duplicate, false);
  assert.equal(revoked.record.id, created.id);
  assert.equal(revoked.record.status, 'revoked');
  assert.ok(revoked.record.revokedAt);
  assert.equal(revoked.record.history.length, 2);
  assert.equal(revoked.record.history[1].action, 'revoke');
  assert.equal(revoked.record.history[1].actor, 'user');
  assert.equal(revoked.record.history[1].userEventId, 'ue_2');

  assert.deepEqual(store.expose({}).data, {});
  assert.deepEqual(store.list(), []);
  assert.equal(store.list({ status: 'revoked' }).length, 1);
  assert.equal(store.read(created.id).status, 'revoked');

  const replay = store.revoke({
    id: created.id,
    actor: 'user',
    userEventId: 'ue_2',
    reason: 'the user changed their mind',
    commandId: 'cmd_revoke_1',
    idempotencyKey: 'key_revoke_1',
  });
  assert.equal(replay.duplicate, true);
  assert.equal(store.read(created.id).history.length, 2);
  assert.equal(store.revision(), 2);

  assertPrefError(() => store.correct({
    id: created.id, value: 'x', actor: 'user', userEventId: 'ue_3', commandId: 'cmd_after_revoke',
  }), 'PREFERENCE_REVOKED');
  assertPrefError(() => store.revoke({
    id: created.id, actor: 'user', userEventId: 'ue_3', commandId: 'cmd_revoke_again',
  }), 'ALREADY_REVOKED');
  assertPrefError(() => store.revoke({
    id: created.id, actor: 'agent', userEventId: 'ue_3', commandId: 'cmd_revoke_agent',
  }), 'AGENT_CANNOT_SET_PREFERENCE');
});

test('system migration is allowed only with an explicit reason', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  assertPrefError(() => store.set(setInput({
    scope: 'project',
    scopeId: 'proj_1',
    actor: 'system',
    commandId: 'cmd_system_no_reason',
  })), 'MISSING_REASON');

  const migrated = store.set(setInput({
    scope: 'project',
    scopeId: 'proj_1',
    key: 'voice',
    value: 'narrator',
    actor: 'system',
    userEventId: 'ue_migration_1',
    reason: 'migrated from the legacy preference file',
    commandId: 'cmd_system_migration',
  }));
  assert.equal(migrated.record.actor, 'system');
  assert.equal(migrated.record.reason, 'migrated from the legacy preference file');
  assert.equal(migrated.record.history[0].reason, 'migrated from the legacy preference file');
});

test('refuses local filesystem paths in values and reasons', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const bad = [
    '/etc/passwd',
    '/var/tmp/voice.wav',
    './relative/clip.wav',
    '../clip.wav',
    '~/clip.wav',
    'file:///etc/passwd',
    'C:\\data\\clip.wav',
    'C:/data/clip.wav',
    '\\\\server\\share\\clip.wav',
  ];
  for (const value of bad) {
    assertPrefError(() => store.set(setInput({
      value,
      commandId: `cmd_path_${bad.indexOf(value)}`,
    })), 'LOCAL_PATH_FORBIDDEN');
  }
  assertPrefError(() => store.set(setInput({
    value: { nested: ['ok', 'D:\\media\\clip.wav'] },
    commandId: 'cmd_nested_path',
  })), 'LOCAL_PATH_FORBIDDEN');
  assertPrefError(() => store.set(setInput({
    reason: '/var/tmp/preferences.txt',
    commandId: 'cmd_reason_path',
  })), 'LOCAL_PATH_FORBIDDEN');

  assert.equal(store.revision(), 0);
  assert.deepEqual(store.list(), []);
});

test('validates the preference key and JSON value', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  assertPrefError(() => store.set(setInput({ key: 'bad key', commandId: 'cmd_bad_key' })), 'INVALID_KEY');
  assertPrefError(() => store.set(setInput({ key: '', commandId: 'cmd_empty_key' })), 'INVALID_KEY');
  assertPrefError(() => store.set(setInput({ value: undefined, commandId: 'cmd_undefined_value' })), 'INVALID_VALUE');
  assertPrefError(() => store.set(setInput({ value: Number.NaN, commandId: 'cmd_nan' })), 'INVALID_VALUE');
  assertPrefError(() => store.set(setInput({ value: Infinity, commandId: 'cmd_infinity' })), 'INVALID_VALUE');
  assertPrefError(() => store.set(setInput({ value: () => 'no', commandId: 'cmd_function' })), 'INVALID_VALUE');
  assertPrefError(() => store.set(setInput({ value: 1n, commandId: 'cmd_bigint' })), 'INVALID_VALUE');
  const circular = {};
  circular.self = circular;
  assertPrefError(() => store.set(setInput({ value: circular, commandId: 'cmd_circular' })), 'INVALID_VALUE');

  // Structured JSON values are fine and are stored by value.
  const structured = store.set(setInput({
    key: 'delivery',
    value: { pace: 'measured', emphasis: ['name'], avoid: 'generic announcer' },
    commandId: 'cmd_structured',
  }));
  assert.deepEqual(store.read(structured.record.id).value, {
    pace: 'measured', emphasis: ['name'], avoid: 'generic announcer',
  });
});

test('set rejects a second active record for the same scope and key', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  store.set(setInput());
  assertPrefError(() => store.set(setInput({
    commandId: 'cmd_second_set',
    idempotencyKey: 'key_second_set',
  })), 'PREFERENCE_EXISTS');
  assert.equal(store.revision(), 1);

  // A different scope is a different preference, not a duplicate.
  const otherScope = store.set(setInput({
    scope: 'project',
    scopeId: 'proj_1',
    commandId: 'cmd_other_scope',
  }));
  assert.equal(otherScope.record.scope, 'project');
});

test('expose returns plain data, a plain prompt and a stable fingerprint', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const announcer = store.set(setInput({
    value: 'avoid <b>generic</b> announcer & keep it plain',
    commandId: 'cmd_markup',
  })).record;
  store.set(setInput({
    key: 'tone',
    value: 'warm',
    commandId: 'cmd_tone',
  }));

  const first = store.expose({ characterId: 'basil' });
  assert.equal(typeof first.prompt, 'string');
  assert.equal(typeof first.fingerprint, 'string');
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.data.announcer, 'avoid <b>generic</b> announcer & keep it plain');
  assert.equal(first.prompt.includes('avoid'), true);
  assert.equal(first.prompt.includes('<'), false);
  assert.equal(first.prompt.includes('>'), false);
  assert.equal(first.prompt.includes('&'), false);
  assert.equal(first.prompt.includes('\\u003cb\\u003e'), true);
  assert.deepEqual(first.overrides, []);
  assert.equal('html' in first, false);

  const second = store.expose({ characterId: 'basil' });
  assert.deepEqual(second, first);

  // Any relevant correction changes the exposure fingerprint.
  store.correct({
    id: announcer.id,
    value: 'avoid generic announcer and any theatrical read',
    actor: 'user',
    userEventId: 'ue_2',
    commandId: 'cmd_markup_correct',
  });
  const third = store.expose({ characterId: 'basil' });
  assert.notEqual(third.fingerprint, first.fingerprint);
  assert.equal(third.prompt.includes('theatrical'), true);

  // Reordering object keys in data does not make the fingerprint unstable.
  const fourth = store.expose({ characterId: 'basil' });
  assert.equal(fourth.fingerprint, third.fingerprint);
});

test('read, list and expose validate their inputs without hidden aliases', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);

  const created = store.set(setInput()).record;
  store.set(setInput({
    scope: 'project',
    scopeId: 'proj_1',
    key: 'voice',
    value: 'narration',
    commandId: 'cmd_project_list',
  }));

  assert.equal(store.read('pref_missing'), null);
  assert.equal(store.history('pref_missing'), null);
  assertPrefError(() => store.read({ id: created.id }), 'INVALID_INPUT');
  assertPrefError(() => store.history({ id: created.id }), 'INVALID_INPUT');

  assert.equal(store.list().length, 2);
  assert.equal(store.list({ scope: 'user' }).length, 1);
  assert.equal(store.list({ scope: 'project', scopeId: 'proj_1' }).length, 1);
  assert.equal(store.list({ key: 'voice' }).length, 1);
  assertPrefError(() => store.list({ scopeKind: 'user' }), 'INVALID_INPUT');
  assertPrefError(() => store.list({ scopeId: 'proj_1' }), 'INVALID_INPUT');
  assertPrefError(() => store.list({ status: 'deleted' }), 'INVALID_INPUT');
  assertPrefError(() => store.list({ includeRevoked: true }), 'INVALID_INPUT');

  assertPrefError(() => store.expose({ scope: 'user' }), 'INVALID_INPUT');
  assertPrefError(() => store.expose({ characterId: 'bad id' }), 'INVALID_INPUT');
  assertPrefError(() => store.expose({ language: 'not a locale' }), 'INVALID_SCOPE');
  assertPrefError(() => store.expose(null), 'INVALID_INPUT');
});

test('choose the store runtime explicitly and reject rootDir', (t) => {
  const runtimeDir = tempRuntime(t);
  assertPrefError(() => createPreferencesStore({ rootDir: runtimeDir }), 'INVALID_OPTIONS');
  assertPrefError(() => createPreferencesStore({}), 'INVALID_OPTIONS');
  assertPrefError(() => createPreferencesStore({ runtimeDir: '' }), 'INVALID_OPTIONS');
  assertPrefError(() => createPreferencesStore(null), 'INVALID_OPTIONS');

  const store = createPreferencesStore({ runtimeDir, clock: () => new Date(AT) });
  const created = store.set(setInput({ value: 'explicit runtime' }));
  assert.equal(created.record.value, 'explicit runtime');
  assert.equal(fs.existsSync(join(runtimeDir, 'preferences', 'preferences.json')), true);
});

test('a corrupt snapshot is reported instead of trusted', (t) => {
  const runtimeDir = tempRuntime(t);
  fs.mkdirSync(join(runtimeDir, 'preferences'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(runtimeDir, 'preferences', 'preferences.json'), '{ not json', { mode: 0o600 });
  const store = makeStore(t, runtimeDir);

  assertPrefError(() => store.list(), 'CORRUPT_STATE');
  assertPrefError(() => store.set(setInput()), 'CORRUPT_STATE');
});
