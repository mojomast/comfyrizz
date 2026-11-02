import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../src/ref-watch/decide.mjs';
import { validateRefDecision } from '../../../../packages/schema/src/ref-review.mjs';

const sha = 'a'.repeat(64);
const check = (dimension, pass, severity = 'hard') => ({ dimension, pass, severity, evidence: `${dimension} ${pass ? 'ok' : 'off'}` });
const dims = ['technical', 'identity', 'anatomy', 'framing', 'prompt', 'text_artifact'];
const verdict = (fails) => ({
  schema: 'comfyrizz.ref-review.verdict/v1', jobId: 'o1.still', keyframeSha256: sha, reviewer: 'pi', overall: 'fail',
  checks: dims.map((d) => check(d, !fails.includes(d))), fixHints: ['full-body wide shot'],
});
const run = (fails, attempt, regenJobsUsed = 0) => decide({ verdict: verdict(fails), attempt, regenJobsUsed, stillCount: 7, identityFailures: 0 });

test('framing-only: one regen, then accept with a soft note', () => {
  assert.equal(run(['framing'], 0).action, 'reprompt');
  const second = run(['framing'], 1);
  assert.equal(second.action, 'accept');
  assert.match(second.reason, /framing-only/);
  assert.ok(second.softNote);
  assert.equal(validateRefDecision(second).ok, true);
});

test('framing-only with the regen budget closed accepts at once', () => {
  const d = run(['framing'], 0, 999);
  assert.equal(d.action, 'accept');
  assert.match(d.reason, /budget closed/);
});

test('framing plus another hard fail keeps the normal path (no early give-up)', () => {
  assert.notEqual(run(['framing', 'identity'], 1).action, 'accept');
  assert.notEqual(run(['framing', 'anatomy'], 2).action, 'accept');
  assert.notEqual(run(['technical'], 1).action, 'accept');
});

test('prompt (untrusted) plus framing is still framing-only', () => {
  assert.equal(run(['framing', 'prompt'], 1).action, 'accept');
});
