// UX00: shared web contracts for save state and the Easy project session.
// Fixtures only; no server, no storage, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SAVE_STATE_CONTRACT,
  SAVE_STATUSES,
  SAVE_STATUS_MEANING,
  isServerSaved,
  validateSaveState,
  type SaveState,
} from '../src/editor/save-state.ts';
import { createEditorStore, saveStatusText } from '../src/editor/store.ts';
import {
  EASY_SESSION_CONTRACT,
  NEW_PROJECT_CARRY,
  NEW_PROJECT_RESET,
  RESULT_READINESS,
  isCurrentSession,
  resultReadiness,
} from '../src/easy/session-contract.ts';
import { defaultEasyState } from '../src/easy/store.ts';

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`./fixtures/ux00/${name}`, import.meta.url), 'utf8'));
}

const saveFixture = fixture('save-state.json');
const sessionFixture = fixture('session.json');

test('UX00 save state: fixtures name the contract version', () => {
  assert.equal(saveFixture.contract, SAVE_STATE_CONTRACT);
  assert.equal(sessionFixture.contract, EASY_SESSION_CONTRACT);
});

test('UX00 save state: valid fixtures validate and report server-saved only on ack', () => {
  for (const { name, state, serverSaved } of saveFixture.valid) {
    assert.deepEqual(validateSaveState(state), { ok: true, errors: [] }, name);
    assert.equal(isServerSaved(state as SaveState), serverSaved, name);
  }
});

test('UX00 save state: invalid fixtures fail with the named codes', () => {
  for (const { name, state, codes } of saveFixture.invalid) {
    const result = validateSaveState(state);
    assert.equal(result.ok, false, name);
    assert.deepEqual([...new Set(result.errors.map((error) => error.code))].sort(), [...codes].sort(), name);
  }
  assert.equal(validateSaveState(null).errors[0].code, 'INVALID_OBJECT');
  assert.equal(validateSaveState([]).errors[0].code, 'INVALID_OBJECT');
});

test('UX00 save state: every existing status literal has one meaning and live copy', () => {
  assert.deepEqual(Object.keys(SAVE_STATUS_MEANING).sort(), [...SAVE_STATUSES].sort());
  assert.equal(new Set(Object.values(SAVE_STATUS_MEANING)).size, SAVE_STATUSES.length);
  for (const status of SAVE_STATUSES) {
    assert.equal(typeof saveStatusText(status, 'reason'), 'string', status);
  }
});

test('UX00 save state: the live editor store reports only frozen literals', () => {
  const store = createEditorStore({
    package: { id: 'pkg_ux00web01', revision: 1, format: { width: 1920, height: 1080, fps: 30 }, scenes: [{ id: 's_one', layout: 'title', preferredFrames: 60, copy: { headline: 'One' } }], assets: {} },
  });
  assert.ok((SAVE_STATUSES as readonly string[]).includes(store.saveStatus()));
  assert.equal(store.dispatch({ type: 'TrimScene', sceneId: 's_one', preferredFrames: 90 }).ok, true);
  assert.ok((SAVE_STATUSES as readonly string[]).includes(store.saveStatus()));
});

test('UX00 session: readiness is derived from evidence; preview never implies export', () => {
  for (const { name, evidence, expect } of sessionFixture.readiness) {
    assert.ok((RESULT_READINESS as readonly string[]).includes(expect), name);
    assert.equal(resultReadiness(evidence), expect, name);
  }
});

test('UX00 session: late results from another project or generation are stale', () => {
  for (const { name, started, current, expect } of sessionFixture.sessions) {
    assert.equal(isCurrentSession(started, current), expect, name);
  }
});

test('UX00 session: new-project reset and carry lists partition the stored record', () => {
  const reset = new Set<string>(NEW_PROJECT_RESET);
  const carry = new Set<string>(NEW_PROJECT_CARRY);
  for (const key of reset) assert.ok(!carry.has(key), `${key} is both reset and carried`);
  assert.deepEqual([...reset, ...carry].sort(), Object.keys(defaultEasyState()).sort());
  for (const key of ['packageId', 'chatId', 'productionId', 'planHash', 'spendCap', 'exported']) {
    assert.ok(reset.has(key), `${key} must reset on a new project`);
  }
});
