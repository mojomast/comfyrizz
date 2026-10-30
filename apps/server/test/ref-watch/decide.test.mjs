import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REF_POLICY_DEFAULTS,
  REF_VERDICT_SCHEMA,
  refRegenJobCap,
  validateRefDecision,
  validateRefVerdict,
} from '../../../../packages/schema/src/ref-review.mjs';
import { decide } from '../../src/ref-watch/decide.mjs';

const SHA = 'a'.repeat(64);

function failed(dimension, severity = 'hard') {
  return { dimension, pass: false, severity, evidence: `${dimension} failed` };
}

function passed(dimension) {
  return { dimension, pass: true, severity: 'hard', evidence: `${dimension} passed` };
}

function verdict(overall, checks = []) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: 'still_s03',
    keyframeSha256: SHA,
    reviewer: 'fake',
    overall,
    checks,
    fixHints: [],
  };
}

const rows = [
  {
    name: 'accepts an overall pass',
    input: { verdict: verdict('pass', [passed('identity'), passed('anatomy')]), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0 },
    action: 'accept',
  },
  {
    name: 'accepts a soft-only failure',
    input: { verdict: verdict('fail', [failed('framing', 'soft')]), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0 },
    action: 'accept',
  },
  {
    name: 'reprompts a hard failure on the first attempt',
    input: { verdict: verdict('fail', [failed('anatomy')]), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0 },
    action: 'reprompt',
  },
  {
    name: 'reprompts a hard failure on the second attempt',
    input: { verdict: verdict('fail', [failed('anatomy')]), attempt: 1, regenJobsUsed: 0, stillCount: 4, identityFailures: 0 },
    action: 'reprompt',
  },
  {
    name: 'escalates when the per-still cap is exhausted',
    input: { verdict: verdict('fail', [failed('anatomy')]), attempt: 2, regenJobsUsed: 0, stillCount: 4, identityFailures: 0 },
    action: 'escalate',
  },
  {
    name: 'escalates when the production cap is exhausted',
    input: { verdict: verdict('fail', [failed('anatomy')]), attempt: 0, regenJobsUsed: 1, stillCount: 4, identityFailures: 0 },
    action: 'escalate',
  },
  {
    name: 'replaces the reference when identity has failed twice',
    input: { verdict: verdict('fail', [failed('identity')]), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 2 },
    action: 'replace_ref',
  },
  {
    name: 'reprompts identity on its first failure',
    input: { verdict: verdict('fail', [failed('identity')]), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 1 },
    action: 'reprompt',
  },
  {
    name: 'escalates identity replacement when no cap slot remains',
    input: { verdict: verdict('fail', [failed('identity')]), attempt: 0, regenJobsUsed: 1, stillCount: 4, identityFailures: 2 },
    action: 'escalate',
  },
  {
    name: 'escalates a judge error',
    input: { verdict: verdict('error'), attempt: 1, regenJobsUsed: 0, stillCount: 4, identityFailures: 0 },
    action: 'escalate',
  },
  {
    name: 'escalates a judge error even when caps are exhausted',
    input: { verdict: verdict('error'), attempt: 2, regenJobsUsed: 3, stillCount: 4, identityFailures: 2 },
    action: 'escalate',
  },
  {
    name: 'escalates a hard failure with no stills and no production cap',
    input: { verdict: verdict('fail', [failed('anatomy')]), attempt: 0, regenJobsUsed: 0, stillCount: 0, identityFailures: 0 },
    action: 'escalate',
  },
];

test('decision table: 12 rows', () => {
  assert.equal(rows.length, 12);
  assert.equal(refRegenJobCap(4, REF_POLICY_DEFAULTS), 1);
  for (const row of rows) {
    assert.equal(validateRefVerdict(row.input.verdict).ok, true, `${row.name}: fixture verdict is valid`);
    const decision = decide(row.input);
    assert.equal(validateRefDecision(decision).ok, true, `${row.name}: ${validateRefDecision(decision).errors.join('; ')}`);
    assert.equal(decision.action, row.action, row.name);
    assert.equal(decision.attempt, row.input.attempt, `${row.name}: attempt is echoed`);
    assert.equal(decision.jobId, row.input.verdict.jobId, `${row.name}: jobId follows the verdict`);
    assert.equal(decision.keyframeSha256, row.input.verdict.keyframeSha256, `${row.name}: sha follows the verdict`);
    if (row.action === 'reprompt') assert.equal(decision.nextPrompt, '<steer>', `${row.name}: placeholder steer prompt`);
    if (row.action === 'replace_ref') assert.ok(typeof decision.replaceRef === 'string' && decision.replaceRef.length > 0, `${row.name}: replaceRef present`);
  }
});

test('a verdict that fails validation escalates (pass that contradicts a hard failure)', () => {
  const sha = 'a'.repeat(64);
  const verdict = { schema: REF_VERDICT_SCHEMA, jobId: 'still_x', keyframeSha256: sha, reviewer: 'pi', overall: 'pass',
    checks: [{ dimension: 'anatomy', pass: false, severity: 'hard', evidence: 'six fingers' }], fixHints: [] };
  const d = decide({ verdict, attempt: 0, regenJobsUsed: 0, stillCount: 8, identityFailures: 0 });
  assert.equal(d.action, 'escalate');
  assert.equal(validateRefDecision(d).ok, true);
});
