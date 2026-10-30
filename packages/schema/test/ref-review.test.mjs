import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateRefReviewRequest, validateRefVerdict, validateRefDecision,
  refRegenJobCap, refGateOpen, REF_POLICY_DEFAULTS, REF_GATE_STATES, REF_EVENTS,
} from '../src/ref-review.mjs';

const fx = name => JSON.parse(readFileSync(new URL(`./fixtures/ref-review/${name}.json`, import.meta.url), 'utf8'));

test('good request validates', () => assert.deepEqual(validateRefReviewRequest(fx('request.good')), { ok: true, errors: [] }));
test('bad request lists each problem', () => {
  const r = validateRefReviewRequest(fx('request.bad'));
  assert.equal(r.ok, false);
  for (const s of ['keyframeSha256', 'imagePath', 'width', 'attempt', 'characters[0]']) assert.ok(r.errors.some(e => e.includes(s)), s);
});
test('pass verdict with only a soft failure validates', () => assert.equal(validateRefVerdict(fx('verdict.pass')).ok, true));
test('fail verdict validates', () => assert.equal(validateRefVerdict(fx('verdict.fail')).ok, true));
test('pass verdict that contradicts a failed hard check is rejected', () => {
  const r = validateRefVerdict(fx('verdict.contradiction'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('contradicts')));
});
test('fail verdict without any failed check is rejected', () => {
  const v = { ...fx('verdict.fail'), checks: [{ dimension: 'anatomy', pass: true, severity: 'hard', evidence: '' }] };
  assert.equal(validateRefVerdict(v).ok, false);
});
test('unknown dimension and long evidence are rejected', () => {
  const v = { ...fx('verdict.fail'), checks: [{ dimension: 'vibes', pass: false, severity: 'hard', evidence: 'x'.repeat(401) }] };
  const r = validateRefVerdict(v);
  assert.ok(r.errors.some(e => e.includes('dimension')) && r.errors.some(e => e.includes('evidence')));
});
test('reprompt decision validates; override without receipt is rejected', () => {
  assert.equal(validateRefDecision(fx('decision.reprompt')).ok, true);
  const r = validateRefDecision(fx('decision.override-noreceipt'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('receiptId')));
});
test('regen job cap is min(6, max(2, 25% of stills)), and 0 when there is no still', () => {
  assert.deepEqual(REF_POLICY_DEFAULTS, { maxRegensPerStill: 2, maxRegenJobs: 6, maxRegenFraction: 0.25 });
  assert.deepEqual([0, 1, 4, 8, 12, 24, 40].map(n => refRegenJobCap(n)), [0, 2, 2, 2, 3, 6, 6]);
});
test('gate is fail-closed', () => {
  assert.deepEqual(REF_GATE_STATES.filter(refGateOpen), ['accepted', 'overridden']);
  assert.equal(refGateOpen(undefined), false);
  assert.equal(REF_EVENTS.length, 6);
});
test('package export resolves', async () => {
  const m = await import('@comfyrizz/schema/ref-review');
  assert.equal(typeof m.validateRefVerdict, 'function');
});
