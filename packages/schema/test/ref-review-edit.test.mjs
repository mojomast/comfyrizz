import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRefDecision, REF_ACTIONS, REF_EDIT_DIMENSIONS, REF_DIMENSIONS,
} from '../src/ref-review.mjs';

const SHA = 'a'.repeat(64);

const decision = (over = {}) => ({
  schema: 'comfyrizz.ref-review.decision/v1',
  jobId: 'job-1',
  keyframeSha256: SHA,
  action: 'targeted_edit',
  reason: 'fix the hand',
  attempt: 0,
  ...over,
});

test('targeted_edit is a known action and edit dimensions are a frozen export', () => {
  assert.ok(REF_ACTIONS.includes('targeted_edit'));
  assert.deepEqual([...REF_EDIT_DIMENSIONS], ['text_artifact', 'anatomy', 'wardrobe']);
  assert.ok(Object.isFrozen(REF_EDIT_DIMENSIONS));
});

test('wardrobe is only an edit dimension, never a verdict dimension', () => {
  assert.equal(REF_DIMENSIONS.includes('wardrobe'), false);
});

test('valid targeted_edit decisions pass for every edit dimension', () => {
  for (const editDimension of REF_EDIT_DIMENSIONS) {
    const r = validateRefDecision(decision({ editInstruction: 'five fingers clearly visible', editDimension }));
    assert.deepEqual(r, { ok: true, errors: [] }, editDimension);
  }
});

test('targeted_edit without editInstruction is rejected', () => {
  const r = validateRefDecision(decision({ editDimension: 'anatomy' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('editInstruction')));
});

test('targeted_edit with an empty or non-string editInstruction is rejected', () => {
  for (const editInstruction of ['', '   ', 42]) {
    const r = validateRefDecision(decision({ editInstruction, editDimension: 'text_artifact' }));
    assert.equal(r.ok, false, String(editInstruction));
    assert.ok(r.errors.some(e => e.includes('editInstruction')));
  }
});

test('targeted_edit with a negative editInstruction is rejected', () => {
  const r = validateRefDecision(decision({ editInstruction: 'no extra fingers', editDimension: 'anatomy' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('editInstruction')));
});

test('targeted_edit with a missing or out-of-set editDimension is rejected', () => {
  for (const editDimension of [undefined, 'identity', 'technical']) {
    const r = validateRefDecision(decision({ editInstruction: 'clean five-finger hand', editDimension }));
    assert.equal(r.ok, false, String(editDimension));
    assert.ok(r.errors.some(e => e.includes('editDimension')));
  }
});

test('old decisions still validate (regression)', () => {
  const cases = [
    decision({ action: 'accept' }),
    decision({ action: 'reprompt', nextPrompt: 'a calmer stance' }),
    decision({ action: 'replace_ref', replaceRef: 'refs/hero.png' }),
    decision({ action: 'escalate' }),
    decision({ action: 'override', receiptId: 'receipt-1' }),
  ];
  for (const d of cases) assert.deepEqual(validateRefDecision(d), { ok: true, errors: [] }, d.action);
});
